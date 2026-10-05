"""#1053 render, atomic patch, and disposable API-server regression evidence."""
import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "charts/in-falcone/migrations/executor-jwt-env-upgrade.py"
spec = importlib.util.spec_from_file_location("migration", HELPER)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
RELEASE = "falcone-upgrade"
NAME = RELEASE + "-control-plane-executor"
CONFIG = RELEASE + "-executor-jwt-config"
GIT = ["git", "-c", f"safe.directory={ROOT}", "-C", str(ROOT)]
LAYERS = {
    "default": [],
    "staging": ["charts/in-falcone/values/staging.yaml"],
    "prod": ["charts/in-falcone/values/prod.yaml"],
    "prod-tls": ["charts/in-falcone/values/prod.yaml", "deploy/kind/values-production.yaml"],
    "kind-tls": ["deploy/kind/values-kind.yaml", "deploy/kind/values-production.yaml"],
}
BASE_REVISION = "93ee9371fdbd029ff49909ff1fb5c03eeff0ddae"
UPGRADE_VALUES = "tests/blackbox/fixtures/executor-env-upgrade-values.yaml"


def command(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=360, **kwargs)
    if result.returncode:
        raise AssertionError("command failed: " + Path(args[0]).name)
    return result.stdout


def historical_checkout(directory, revision="433be51"):
    result = subprocess.run(GIT + ["archive", revision, "charts/in-falcone", "deploy/kind"],
                            capture_output=True, timeout=60)
    if result.returncode:
        raise AssertionError("historical revision unavailable")
    # Avoid tar's sandbox-dependent metadata syscalls; copy bounded regular files.
    with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
        for member in archive:
            if member.isfile():
                target = (directory / member.name).resolve()
                assert target.is_relative_to(directory)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())


def render(root, profile="default", namespace="falcone-upgrade", legacy_literals=False,
           upgrade=False):
    args = ["helm", "template", RELEASE, str(root / "charts/in-falcone"), "-n", namespace]
    for layer in LAYERS[profile]:
        args += ["-f", str(root / layer)]
    if legacy_literals:
        args += ["-f", str(ROOT / "tests/blackbox/fixtures/executor-env-before-980.yaml")]
    if upgrade:
        args += ["--is-upgrade", "-f", str(ROOT / UPGRADE_VALUES)]
    return [item for item in yaml.load_all(command(args), Loader=yaml.CSafeLoader) if item]


def select(objects, kind, name):
    items = [item for item in objects if item["kind"] == kind and item["metadata"]["name"] == name]
    assert len(items) == 1, "exactly one named resource required"
    return items[0]


def env(deployment):
    return next(item for item in deployment["spec"]["template"]["spec"]["containers"]
                if item["name"] == "control-plane-executor")["env"]


def validate_new_replicasets(items, baseline, deployment_uid):
    created = []
    for item in items:
        if not any(owner.get("uid") == deployment_uid and owner.get("controller")
                   for owner in item["metadata"].get("ownerReferences", [])):
            continue
        if item["metadata"]["uid"] not in baseline:
            migration.validate_env(env(item), CONFIG)
            created.append(item["metadata"]["uid"])
    return set(created)


def resolved_jwt(objects, deployment):
    # Resolve only credential-free JWT ConfigMap references internally; never print payloads.
    result = {}
    for entry in env(deployment):
        if entry["name"] not in migration.JWT_NAMES:
            continue
        if "valueFrom" in entry:
            ref = entry["valueFrom"]["configMapKeyRef"]
            value = select(objects, "ConfigMap", ref["name"])["data"][ref["key"]]
        else:
            value = entry["value"]
        result[entry["name"]] = value  # historical Kubernetes last-entry-wins behavior
    return result


def probe(deployment, image):
    result = copy.deepcopy(deployment)
    # The API defaults the initial replica count to one. Neither Helm manifest
    # claims replicas, so the simulated HPA can own it across SSA retries.
    result["spec"].pop("replicas", None)
    jwt = [item for item in env(result) if item["name"] in migration.JWT_NAMES]
    result["spec"]["template"]["spec"] = {"containers": [{
        "name": "control-plane-executor", "image": image, "imagePullPolicy": "IfNotPresent",
        "env": jwt, "command": ["sh", "-c", "sleep 3600"],
        "readinessProbe": {"exec": {"command": ["sh", "-c",
            'test -n "$KEYCLOAK_JWKS_URL" && test -n "$KEYCLOAK_ISSUER" && test -n "$KEYCLOAK_AUDIENCE"']}, "periodSeconds": 1},
    }]}
    return result


def rejected_dual_field(result):
    # Kubernetes quotes `value` in its validation error; the issue's reported
    # message and older fake clients omit the backticks. Require a failed request
    # and the same validation error in either spelling, never an arbitrary error.
    message = result.stderr.replace("`value`", "value")
    return result.returncode != 0 and "may not be specified when value is not empty" in message


def delivery_outcome(result, scenario, path):
    if result.returncode == 0:
        return "PASS"
    if rejected_dual_field(result):
        return "REJECTED_DUAL_FIELD"
    if (scenario == "existing980-tls"
            and ("duplicate" in result.stderr.lower() or "$setElementOrder" in result.stderr)
            and "KEYCLOAK_JWKS_URL" in result.stderr):
        return "REJECTED_DUPLICATE_ENV"
    raise AssertionError(scenario + "/" + path + ": unexpected delivery failure (payload redacted)")


class Offline(unittest.TestCase):
    def test_helper_real_upgrade_render_requires_explicit_probe_values(self):
        # Exercise the helper's actual Helm command, not a mocked render. The
        # install-only profiles previously passed every offline fake but failed
        # at the backup/parity and currentVersion gates in the first live dry-run.
        revision = command(GIT + ["rev-parse", "HEAD"]).strip()
        for profile in LAYERS:
            objects = render(ROOT, profile)
            target = select(objects, "Deployment", NAME)
            config = select(objects, "ConfigMap", CONFIG)
            upgraded = render(ROOT, profile, upgrade=True)
            self.assertTrue(select(upgraded, "Deployment", NAME) == target,
                            "probe upgrade values must preserve the executor render")
            self.assertTrue(select(upgraded, "ConfigMap", CONFIG) == config,
                            "probe upgrade values must preserve JWT configuration")
            live = copy.deepcopy(target)
            live["metadata"]["resourceVersion"] = "42"
            env(live)[:] = [{"name": key, "value": "old"} for key in migration.JWT_NAMES[:3]]
            for explicit_values in (False, True):
                with self.subTest(profile=profile, explicit_values=explicit_values):
                    calls = []
                    def real_render_fake_cluster(args, **kwargs):
                        calls.append(args)
                        if args[0] == "git":
                            if "rev-parse" in args:
                                return revision
                            return ""  # revision/clean-input behavior has separate tests
                        if args[0] == "helm":
                            self.assertIn("--is-upgrade", args)
                            return migration_run(args, **kwargs)
                        if "configmap" in args:
                            return json.dumps(config)
                        if "get" in args:
                            return json.dumps(live)
                        if "patch" in args:
                            self.assertIn("--dry-run=server", args)
                            migration.validate_env(json.loads(kwargs["input"])[1]["value"], CONFIG)
                            return ""
                        raise AssertionError("unexpected fake cluster call")
                    argv = [str(HELPER), "--revision", revision, "--release", RELEASE,
                            "--namespace", "falcone-upgrade", "--context", "kind-fake"]
                    for layer in LAYERS[profile] + ([UPGRADE_VALUES] if explicit_values else []):
                        argv += ["--values", layer]
                    migration_run = migration.run
                    with mock.patch.object(migration, "run", side_effect=real_render_fake_cluster), \
                            mock.patch.object(migration.sys, "argv", argv), redirect_stdout(io.StringIO()):
                        if explicit_values:
                            migration.main()
                            self.assertEqual(sum("patch" in call for call in calls), 1)
                        else:
                            with self.assertRaisesRegex(ValueError, "^EXECUTOR_UPGRADE_COMMAND_FAILED$"):
                                migration.main()
                            self.assertFalse(any(call[0] == "kubectl" for call in calls),
                                             "ungated upgrade must fail before API access")

    def test_dual_field_rejection_recognizes_api_message_without_accepting_other_failures(self):
        for value in ("`value`", "value"):
            error = ('The Deployment "executor" is invalid: '
                     'spec.template.spec.containers[0].env[0].valueFrom: Invalid value: "": '
                     f'may not be specified when {value} is not empty')
            rejected = subprocess.CompletedProcess([], 1, "", error)
            self.assertTrue(rejected_dual_field(rejected))
            for path in ("helm3-client", "argo-client", "helm4-server"):
                self.assertEqual(delivery_outcome(rejected, "pre980", path), "REJECTED_DUAL_FIELD")
            # Matching text is evidence only when the API request actually fails.
            self.assertFalse(rejected_dual_field(subprocess.CompletedProcess([], 0, "", error)))
        for error in ("", "Forbidden", "unable to read patch file", "may not specify more than 1 volume type"):
            rejected = subprocess.CompletedProcess([], 1, "", error)
            self.assertFalse(rejected_dual_field(rejected))
            with self.assertRaisesRegex(AssertionError, "unexpected delivery failure"):
                delivery_outcome(rejected, "pre980", "argo-client")
        self.assertFalse(rejected_dual_field(subprocess.CompletedProcess(
            [], 1, "may not be specified when `value` is not empty", "")))

    def test_completed_matrix_persists_all_paths_and_client_versions(self):
        with tempfile.TemporaryDirectory(prefix="executor-evidence-") as folder:
            work = Path(folder)
            output = work / "evidence.json"
            calls = []
            def fake_command(args, **kwargs):
                calls.append(args)
                if args[0] == "reviewed-helm3":
                    return "v3.17.3\n"
                if args[:2] == ["helm", "version"]:
                    return "v4.1.4\n"
                return "a" * 40 + "\n"
            def fake_case(*args, **kwargs):
                if not kwargs["positive"]:
                    return "REJECTED_DUAL_FIELD" if args[-1] == "argo-client" else "PASS"
                return {"atomic_step": "PASS", "delivery": "PASS", "new_replicasets": 1}
            with mock.patch.dict(os.environ, {"HELM3_BIN": "reviewed-helm3",
                                               "EXECUTOR_UPGRADE_EVIDENCE": str(output)}), \
                    mock.patch(__name__ + ".command", side_effect=fake_command), \
                    mock.patch(__name__ + ".historical_checkout"), \
                    mock.patch.object(Live, "run_case", side_effect=fake_case) as cases, \
                    redirect_stdout(io.StringIO()):
                Live().matrix(work, "kind-disposable", {})
            evidence = json.loads(output.read_text())
            self.assertEqual(cases.call_count, 12)
            self.assertEqual(len(evidence["paths"]), 6)
            self.assertEqual(len(evidence["justification"]), 6)
            self.assertEqual({item["path"] for item in evidence["paths"]},
                             {"helm3-client", "argo-client", "helm4-server"})
            self.assertEqual({item["scenario"] for item in evidence["paths"]},
                             {"pre980", "existing980-tls"})
            self.assertEqual(evidence["helm3"], "v3.17.3")
            self.assertEqual(evidence["helm4"], "v4.1.4")
            self.assertEqual(evidence["probe_upgrade_values_layer"], UPGRADE_VALUES)
            self.assertEqual(evidence["probe_upgrade_values_sha256"],
                             hashlib.sha256((ROOT / UPGRADE_VALUES).read_bytes()).hexdigest())
            self.assertIn(["reviewed-helm3", "version", "--short"], calls)
            self.assertTrue(all(item["atomic_step"] == "PASS" for item in evidence["paths"]))

    def test_paused_real_render_delivery_repairs_accepted_env_and_retries_rejection(self):
        real_command, real_process = command, subprocess.run
        with tempfile.TemporaryDirectory(prefix="executor-delivery-") as folder:
            work = Path(folder)
            old_root, tls_root = work / "old", work / "tls"
            historical_checkout(old_root)
            historical_checkout(tls_root, BASE_REVISION)
            sources = (("pre980", old_root, "default", True),
                       ("existing980-tls", tls_root, "prod-tls", False),
                       ("existing980-tls", tls_root, "kind-tls", False))
            for scenario, source, profile, literals in sources:
                for path in ("helm3-client", "argo-client", "helm4-server"):
                    with self.subTest(scenario=scenario, profile=profile, path=path):
                        sandbox = work / (profile + "-" + path)
                        sandbox.mkdir()
                        target = select(render(ROOT, profile), "Deployment", NAME)
                        wanted_config = select(render(ROOT, profile), "ConfigMap", CONFIG)
                        state = {"deployment": None, "config": None, "replicasets": [], "deliveries": 0}
                        events = []

                        def fake_command(args, **kwargs):
                            if args[0] == "helm3" and args[1] == "install":
                                chart = Path(args[3])
                                live = yaml.safe_load((chart / "templates/executor.yaml").read_text())
                                live["metadata"].update(uid="executor", resourceVersion="1", generation=1)
                                live["spec"]["replicas"] = 1
                                state["deployment"] = live
                                config_file = chart / "templates/config.yaml"
                                state["config"] = yaml.safe_load(config_file.read_text()) if config_file.exists() else None
                                rs = copy.deepcopy(live)
                                rs["metadata"].update(uid="old", ownerReferences=[{"uid": "executor", "controller": True}])
                                state["replicasets"] = [rs]
                                return ""
                            if args[:2] == ["python3", str(HELPER)]:
                                self.assertGreater(state["deliveries"], 0, "helper must follow target delivery")
                                values = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg == "--values"]
                                self.assertEqual(values, LAYERS[profile] + [UPGRADE_VALUES])
                                migration.validate_config(state["config"], wanted_config)
                                patch = migration.migration_patch(state["deployment"], target, CONFIG)
                                if patch:
                                    self.assertTrue(state["deployment"]["spec"].get("paused"))
                                events.append("repair" if "--apply" in args else "dry-run")
                                if patch and "--apply" in args:
                                    env(state["deployment"])[:] = patch[1]["value"]
                                    state["deployment"]["metadata"]["generation"] += 1
                                return "EXECUTOR_UPGRADE_" + ("APPLIED_PAUSED" if patch else "UNCHANGED_PAUSED")
                            if args[0] != "kubectl":
                                return real_command(args, **kwargs)
                            if "apply" in args:
                                return real_command(args, **kwargs)
                            live = state["deployment"]
                            if "patch" in args:
                                update = json.loads(args[args.index("-p") + 1])
                                live["metadata"].setdefault("annotations", {}).update(update["metadata"]["annotations"])
                                live["spec"]["replicas"] = update["spec"]["replicas"]
                                live["spec"]["template"]["metadata"].setdefault("annotations", {}).update(
                                    update["spec"]["template"]["metadata"]["annotations"])
                            if "rollout" in args:
                                if "pause" in args:
                                    live["spec"]["paused"] = True
                                    events.append("pause")
                                if "resume" in args:
                                    migration.validate_config(state["config"], wanted_config)
                                    migration.validate_env(env(live), CONFIG)
                                    live["spec"]["paused"] = False
                                    live["status"] = {"conditions": [{"type": "Available", "status": "True"}]}
                                    rs = copy.deepcopy(live)
                                    rs["metadata"].update(uid="new", ownerReferences=[{"uid": "executor", "controller": True}])
                                    state["replicasets"].append(rs)
                                    events.append("resume")
                            if "get" in args:
                                if "replicasets" in args:
                                    return json.dumps({"items": state["replicasets"]})
                                if "jsonpath={.metadata.uid}" in args:
                                    return "stable-config" if "configmap" in args else "stable-service"
                                return json.dumps(live)
                            if "exec" in args:
                                return "\n".join(wanted_config["data"][key] for key in migration.JWT_NAMES)
                            return ""

                        def fake_process(args, **kwargs):
                            if args[:2] == ["python3", str(HELPER)]:
                                # Existing TLS ConfigMap mismatch must still fail
                                # before the first target delivery and mutation.
                                with self.assertRaises(ValueError):
                                    migration.validate_config(state["config"], wanted_config)
                                return subprocess.CompletedProcess(args, 1, "", "redacted")
                            if "upgrade" not in args and not (args[0] == "kubectl" and "apply" in args):
                                return real_process(args, **kwargs)
                            live = state["deployment"]
                            self.assertTrue(live["spec"].get("paused"))
                            chart = Path(args[3]) if args[0] != "kubectl" else Path(args[-1]).parent
                            state["config"] = yaml.safe_load((chart / "templates/config.yaml").read_text())
                            state["deliveries"] += 1
                            events.append("delivery")
                            if path == "argo-client" and state["deliveries"] == 1:
                                return subprocess.CompletedProcess(args, 1, "", "may not be specified when value is not empty")
                            # Model Helm accepting an env merge that drops JWKS.
                            env(live)[:] = [entry for entry in env(target)
                                           if entry["name"] != "KEYCLOAK_JWKS_URL"]
                            return subprocess.CompletedProcess(args, 0, "", "")

                        with mock.patch.dict(os.environ, {"HELM3_BIN": "helm3"}), \
                                mock.patch(__name__ + ".command", side_effect=fake_command), \
                                mock.patch.object(subprocess, "run", side_effect=fake_process):
                            outcome = Live().run_case(sandbox, "kind-fake", {}, "offline-probe",
                                                      scenario, source, profile, literals, path, positive=True)
                        self.assertEqual(outcome["delivery"], "PASS")
                        self.assertEqual(outcome["new_replicasets"], 1)
                        self.assertEqual(state["deliveries"], 2 if path == "argo-client" else 1)
                        self.assertLess(events.index("pause"), events.index("delivery"))
                        self.assertLess(events.index("delivery"), events.index("repair"))
                        self.assertLess(events.index("repair"), events.index("resume"))
                        self.assertEqual(outcome["initial_paused_delivery"],
                                         "REJECTED_DUAL_FIELD" if path == "argo-client" else "ACCEPTED_INVALID_JWT_ENV")

    def test_existing_980_tls_probe_preserves_defect_without_owning_replicas(self):
        with tempfile.TemporaryDirectory(prefix="executor-980-tls-") as folder:
            base = Path(folder)
            historical_checkout(base, BASE_REVISION)
            for root, count in ((base, 2), (ROOT, 1)):
                deployment = select(render(root, "prod-tls"), "Deployment", NAME)
                snapshot = copy.deepcopy(deployment)
                manifest = probe(deployment, "offline-probe")
                self.assertNotIn("replicas", manifest["spec"],
                                 "SSA retry must leave replicas owned by the HPA")
                self.assertEqual(deployment, snapshot, "probe must not modify source render")
                jwt = [item for item in env(deployment) if item["name"] in migration.JWT_NAMES]
                self.assertEqual(env(manifest), jwt, "probe must retain the actual historical duplicate")
                self.assertEqual(sum(item["name"] == "KEYCLOAK_JWKS_URL" for item in env(manifest)), count)
                if root == base:
                    with self.assertRaises(ValueError):
                        migration.validate_env(env(manifest), CONFIG)
                else:
                    migration.validate_env(env(manifest), CONFIG)

    def test_reused_historical_tls_values_preserve_jwt_env(self):
        # Model stored, coalesced values without adding current umbrella defaults.
        # This complements the real fake-API Helm reuse-values test (bbx-048).
        def merge_values(target, override):
            for key, value in override.items():
                if isinstance(value, dict) and isinstance(target.get(key), dict):
                    merge_values(target[key], value)
                else:
                    target[key] = copy.deepcopy(value)

        with tempfile.TemporaryDirectory(prefix="executor-reuse-") as folder:
            sandbox = Path(folder)
            old, base, current = (sandbox / name for name in ("old", "base", "current"))
            historical_checkout(old)
            historical_checkout(base, "93ee9371fdbd029ff49909ff1fb5c03eeff0ddae")
            shutil.copytree(ROOT / "charts/in-falcone", current / "charts/in-falcone")
            for profile in ("prod-tls", "kind-tls"):
                stored = yaml.safe_load((old / "charts/in-falcone/values.yaml").read_text())
                for layer in LAYERS[profile]:
                    merge_values(stored, yaml.safe_load((old / layer).read_text()))
                # Preserve the existing identity-path migration gate, as bbx-048
                # does; the obsolete /auth path must not bypass validation.
                stored["publicSurface"]["bindings"]["identity"]["paths"] = ["/realms", "/resources", "/js"]
                self.assertFalse(any("valueFrom" in entry and entry["name"] in migration.JWT_NAMES
                                     for entry in stored["controlPlaneExecutor"].get("env", [])),
                                 "historical values must lack the new JWT references")
                for configured_literals in (False, True):
                    with self.subTest(profile=profile, configured_literals=configured_literals):
                        values = copy.deepcopy(stored)
                        if configured_literals:
                            # Preserve an installed release's issuer/audience too, without
                            # duplicating the JWKS literal supplied by the TLS overlay.
                            fixture = yaml.safe_load((ROOT / "tests/blackbox/fixtures/executor-env-before-980.yaml").read_text())
                            values["controlPlaneExecutor"].setdefault("env", []).extend(
                                entry for entry in fixture["controlPlaneExecutor"]["env"]
                                if entry["name"] != "KEYCLOAK_JWKS_URL")
                        for root in (base, current):
                            (root / "charts/in-falcone/values.yaml").write_text(yaml.safe_dump(values))
                        before, after = render(base), render(current)
                        previous = select(before, "Deployment", NAME)
                        target = select(after, "Deployment", NAME)
                        previous_jwt = resolved_jwt(before, previous)
                        self.assertIn("KEYCLOAK_JWKS_URL", previous_jwt)
                        self.assertTrue(previous_jwt == resolved_jwt(after, target),
                                        "reuse-values must retain effective JWT configuration")
                        for entry in env(target):
                            self.assertFalse("value" in entry and "valueFrom" in entry,
                                             "reused env must never contain both fields")
                        for key in previous_jwt:
                            entries = [entry for entry in env(target) if entry["name"] == key]
                            self.assertEqual(len(entries), 1, "inherited JWT env must remain unique")
                            self.assertIn("value", entries[0], "inherited JWT literals must remain wired")
                        if configured_literals:
                            self.assertTrue(all(key in previous_jwt for key in migration.JWT_NAMES[:3]))

    def test_tls_effective_jwt_and_gateway_preserved(self):
        with tempfile.TemporaryDirectory(prefix="executor-base-") as folder:
            base = Path(folder)
            historical_checkout(base, "93ee9371fdbd029ff49909ff1fb5c03eeff0ddae")
            for profile in ("prod-tls", "kind-tls"):
                before, after = render(base, profile), render(ROOT, profile)
                old_deployment = select(before, "Deployment", NAME)
                new_deployment = select(after, "Deployment", NAME)
                migration.validate_env(env(new_deployment), CONFIG)
                old_jwt = resolved_jwt(before, old_deployment)
                new_jwt = resolved_jwt(after, new_deployment)
                self.assertTrue(old_jwt == new_jwt, "TLS effective JWT configuration must be preserved")
                old_url = urlsplit(old_jwt["KEYCLOAK_JWKS_URL"])
                new_url = urlsplit(new_jwt["KEYCLOAK_JWKS_URL"])
                self.assertTrue((new_url.scheme, new_url.hostname, new_url.port, new_url.path)
                                == (old_url.scheme, old_url.hostname, old_url.port, old_url.path),
                                "TLS JWKS scheme, host, port and path must be preserved")
                self.assertTrue(new_url.scheme == "https" and new_url.port == 8443,
                                "TLS JWKS must remain HTTPS on port 8443")
                def gateway(objects):
                    return [item for item in objects if item["kind"] == "ApisixRoute"
                            or (item["kind"] == "ConfigMap"
                                and item["metadata"]["name"].endswith("-gateway-policy"))]
                self.assertTrue(gateway(before) == gateway(after), "gateway verifier must remain unchanged")
                old_control = select(before, "Deployment", RELEASE + "-control-plane")
                new_control = select(after, "Deployment", RELEASE + "-control-plane")
                self.assertTrue(old_control == new_control, "control-plane TLS configuration must be preserved")

    def test_tls_jwt_source_rejects_ambiguous_entries(self):
        overlay = ROOT / "deploy/kind/values-production.yaml"
        tls_env = yaml.safe_load(overlay.read_text())["global"]["transportSecurity"]["env"]
        non_jwt = [entry for entry in tls_env if entry["name"] not in migration.JWT_NAMES]
        with tempfile.TemporaryDirectory(prefix="executor-invalid-") as folder:
            values = Path(folder) / "invalid.yaml"
            for entries in (
                [{"name": "KEYCLOAK_JWKS_URL", "value": "https://test"}] * 2,
                [{"name": "KEYCLOAK_JWKS_URL", "valueFrom": {"configMapKeyRef": {"name": "test", "key": "test"}}}],
                [{"name": "KEYCLOAK_JWKS_URL", "value": ""}],
            ):
                values.write_text(yaml.safe_dump({"global": {"transportSecurity": {"env": non_jwt + entries}}}))
                result = subprocess.run([
                    "helm", "template", RELEASE, str(ROOT / "charts/in-falcone"),
                    "-f", str(overlay), "-f", str(values),
                ], capture_output=True, text=True, timeout=60)
                self.assertNotEqual(result.returncode, 0, "ambiguous executor JWT source must fail rendering")
                self.assertIn("executor TLS JWT env must contain unique nonempty literals", result.stderr)

    def test_historical_and_current_profiles(self):
        with tempfile.TemporaryDirectory(prefix="executor-old-") as folder:
            old = Path(folder)
            historical_checkout(old)
            for profile in LAYERS:
                untouched = select(render(old, profile), "Deployment", NAME)
                self.assertFalse(any(item["name"] in migration.JWT_NAMES[1:3] for item in env(untouched)),
                                 "do not claim untouched historical defaults have literal issuer/audience")
                before = select(render(old, profile, legacy_literals=True), "Deployment", NAME)
                for key in migration.JWT_NAMES[:3]:
                    entries = [item for item in env(before) if item["name"] == key]
                    self.assertTrue(entries and "value" in entries[0] and "valueFrom" not in entries[0])
                objects = render(ROOT, profile)
                target = select(objects, "Deployment", NAME)
                migration.validate_env(env(target), CONFIG)
                config = select(objects, "ConfigMap", CONFIG)
                self.assertTrue(all(config["data"].get(key) for key in migration.JWT_NAMES))
                if profile.endswith("-tls"):
                    self.assertEqual(sum(item["name"] == "KEYCLOAK_JWKS_URL" for item in env(target)), 1)
                    self.assertTrue(any(item["name"] == "NODE_EXTRA_CA_CERTS" for item in env(target)))

    def test_negative_env_shapes_and_atomic_idempotent_patch(self):
        target = select(render(ROOT), "Deployment", NAME)
        good = env(target)
        for key in migration.JWT_NAMES:
            bad = copy.deepcopy(good)
            bad.append(copy.deepcopy(next(item for item in bad if item["name"] == key)))
            with self.assertRaises(ValueError):
                migration.validate_env(bad, CONFIG)
        bad = copy.deepcopy(good)
        bad.append({"name": "OTHER", "value": "", "valueFrom": {"secretKeyRef": {}}})
        with self.assertRaises(ValueError):
            migration.validate_env(bad, CONFIG)
        live = copy.deepcopy(target)
        live["metadata"]["resourceVersion"] = "42"
        live["metadata"].setdefault("annotations", {})["other-manager"] = "keep"
        live["spec"]["replicas"] = 7
        env(live)[:] = [item for item in env(live) if item["name"] not in migration.JWT_NAMES]
        env(live).extend({"name": name, "value": "old"} for name in migration.JWT_NAMES[:3])
        patch = migration.migration_patch(live, target, CONFIG)
        self.assertEqual([item["op"] for item in patch], ["test", "replace"])
        self.assertEqual(patch[0], {"op": "test", "path": "/metadata/resourceVersion", "value": "42"})
        self.assertEqual(patch[1]["path"], "/spec/template/spec/containers/0/env")
        migration.validate_env(patch[1]["value"], CONFIG)
        self.assertEqual([item for item in env(live) if item["name"] not in migration.JWT_NAMES],
                         [item for item in patch[1]["value"] if item["name"] not in migration.JWT_NAMES])
        env(live)[:] = patch[1]["value"]
        self.assertEqual(migration.migration_patch(live, target, CONFIG), [])
        self.assertEqual(live["spec"]["replicas"], 7)
        self.assertEqual(live["metadata"]["annotations"]["other-manager"], "keep")

    def test_helper_preconditions_with_fake_clients(self):
        objects = render(ROOT, "prod-tls")
        target = select(objects, "Deployment", NAME)
        config = select(objects, "ConfigMap", CONFIG)
        live = copy.deepcopy(target)
        live["metadata"]["resourceVersion"] = "42"
        env(live)[:] = [{"name": key, "value": "old"} for key in migration.JWT_NAMES[:3]]
        original_run, original_argv = migration.run, list(migration.sys.argv)
        revision = "a" * 40
        for failure in ("revision", "dirty", "config", "stale", "empty", "extra", "none"):
            calls = []
            def fake(args, **kwargs):
                calls.append(args)
                if "rev-parse" in args:
                    return ("b" * 40 if failure == "revision" else revision) + "\n"
                if "status" in args:
                    return " M charts/in-falcone/values.yaml" if failure == "dirty" else ""
                if args[0] == "helm":
                    return yaml.safe_dump_all([target, config])
                if "configmap" in args:
                    actual = copy.deepcopy(config)
                    if failure == "config":
                        del actual["data"]["KEYCLOAK_JWKS_URL"]
                    if failure in ("stale", "empty"):
                        actual["data"]["KEYCLOAK_JWKS_URL"] = "http://stale.invalid:8080/jwks" if failure == "stale" else ""
                    if failure == "extra":
                        actual["data"]["unexpected"] = "unexpected"
                    return json.dumps(actual)
                if "get" in args:
                    return json.dumps(live)
                if "patch" in args:
                    self.assertIn("--dry-run=server", args)
                    migration.validate_env(json.loads(kwargs["input"])[1]["value"], CONFIG)
                    return ""
                raise AssertionError("unexpected fake call")
            migration.run = fake
            migration.sys.argv = [str(HELPER), "--revision", revision, "--release", RELEASE,
                                  "--namespace", "disposable", "--context", "kind-test"]
            try:
                if failure == "none":
                    migration.main()
                    self.assertEqual(sum("patch" in call for call in calls), 1)
                else:
                    with self.assertRaises(ValueError):
                        migration.main()
                    self.assertFalse(any("patch" in call for call in calls))
                    self.assertFalse(any("rollout" in call for call in calls))
            finally:
                migration.run, migration.sys.argv = original_run, original_argv

    def test_stale_config_blocks_dry_run_apply_and_noop_without_payload_output(self):
        objects = render(ROOT, "prod-tls")
        target = select(objects, "Deployment", NAME)
        config = select(objects, "ConfigMap", CONFIG)
        stale = copy.deepcopy(config)
        stale["data"]["KEYCLOAK_JWKS_URL"] = "http://stale.invalid:8080/jwks"
        original_run, original_argv = migration.run, list(migration.sys.argv)
        revision = "a" * 40
        try:
            for apply in (False, True):
                for migrated in (False, True):
                    with self.subTest(apply=apply, migrated=migrated):
                        live = copy.deepcopy(target)
                        live["metadata"]["resourceVersion"] = "42"
                        if not migrated:
                            env(live)[:] = [{"name": key, "value": "old"} for key in migration.JWT_NAMES[:3]]
                        calls = []
                        def fake(args, **kwargs):
                            calls.append(args)
                            if "rev-parse" in args:
                                return revision
                            if "status" in args:
                                return ""
                            if args[0] == "helm":
                                return yaml.safe_dump_all([target, config])
                            if "configmap" in args:
                                return json.dumps(stale)
                            if "get" in args:
                                return json.dumps(live)
                            raise AssertionError("stale data must fail before mutation or rollout")
                        migration.run = fake
                        migration.sys.argv = [str(HELPER), "--revision", revision, "--release", RELEASE,
                                              "--namespace", "disposable", "--context", "kind-test"] + (["--apply"] if apply else [])
                        from contextlib import redirect_stdout, redirect_stderr
                        output = io.StringIO()
                        with redirect_stdout(output), redirect_stderr(output):
                            with self.assertRaisesRegex(ValueError, "^EXECUTOR_UPGRADE_CONFIG_MISMATCH$"):
                                migration.main()
                        self.assertEqual(output.getvalue(), "")
                        self.assertFalse(any("patch" in call or "rollout" in call for call in calls))
        finally:
            migration.run, migration.sys.argv = original_run, original_argv

    def test_all_new_replicaset_templates_fail_on_missing_duplicate_or_dual_fields(self):
        target = select(render(ROOT), "Deployment", NAME)
        target["metadata"].update(uid="new", ownerReferences=[{"uid": "executor", "controller": True}])
        baseline = copy.deepcopy(target)
        baseline["metadata"]["uid"] = "old"
        env(baseline)[:] = []  # Only pre-sequence templates are exempt.
        self.assertEqual(validate_new_replicasets([baseline, target], {"old"}, "executor"), {"new"})
        for defect in ("missing", "duplicate", "dual"):
            bad = copy.deepcopy(target)
            bad["metadata"]["uid"] = "superseded"
            if defect == "missing":
                env(bad)[:] = [item for item in env(bad) if item["name"] != "KEYCLOAK_JWKS_URL"]
            elif defect == "duplicate":
                env(bad).append(copy.deepcopy(next(item for item in env(bad)
                                                  if item["name"] == "KEYCLOAK_JWKS_URL")))
            else:
                env(bad).append({"name": "OTHER", "value": "", "valueFrom": {}})
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                validate_new_replicasets([baseline, bad, target], {"old"}, "executor")

    def test_paused_apply_repairs_env_without_resuming_or_waiting_for_rollout(self):
        objects = render(ROOT)
        target = select(objects, "Deployment", NAME)
        config = select(objects, "ConfigMap", CONFIG)
        live = copy.deepcopy(target)
        live["metadata"]["resourceVersion"] = "42"
        live["spec"]["paused"] = True
        # Model an accepted merge that removed JWKS while delivery was paused.
        env(live)[:] = [item for item in env(live) if item["name"] != "KEYCLOAK_JWKS_URL"]
        original_run, original_argv = migration.run, list(migration.sys.argv)
        revision = "a" * 40
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if "rev-parse" in args:
                return revision
            if "status" in args and args[0] == "git":
                return ""
            if args[0] == "helm":
                return yaml.safe_dump_all([target, config])
            if "configmap" in args:
                return json.dumps(config)
            if "get" in args:
                return json.dumps(live)
            if "patch" in args:
                patch = json.loads(kwargs["input"])
                self.assertEqual(patch[0]["value"], live["metadata"]["resourceVersion"])
                self.assertEqual(patch[1]["path"], "/spec/template/spec/containers/0/env")
                env(live)[:] = patch[1]["value"]
                return ""
            raise AssertionError("paused helper must not resume or wait for rollout")
        try:
            migration.run = fake
            migration.sys.argv = [str(HELPER), "--revision", revision, "--release", RELEASE,
                                  "--namespace", "disposable", "--context", "kind-test", "--apply"]
            migration.main()
            migration.validate_env(env(live), CONFIG)
            self.assertTrue(live["spec"]["paused"])
            migration.main()  # Verified no-op remains paused for operator resume.
            self.assertEqual(sum("patch" in call for call in calls), 1)
            self.assertFalse(any("rollout" in call for call in calls))
        finally:
            migration.run, migration.sys.argv = original_run, original_argv

    def test_ci_requires_live_evidence_without_changing_argo_equivalence(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/chart-release.yml").read_text())
        self.assertIn("executor-env-upgrade", workflow["jobs"]["publish"]["needs"])
        steps = workflow["jobs"]["executor-env-upgrade"]["steps"]
        live = next(item for item in steps if item.get("env", {}).get("EXECUTOR_UPGRADE_LIVE") == "1")
        self.assertIn("executor-env-upgrade-contract.test.mjs", live["run"])
        self.assertTrue(any(item.get("with", {}).get("if-no-files-found") == "error" for item in steps))


@unittest.skipUnless(os.environ.get("EXECUTOR_UPGRADE_LIVE") == "1", "live kind matrix runs in PR CI")
class Live(unittest.TestCase):
    def test_upgrade_matrix(self):
        # This entry point creates and owns its kubeconfig; it cannot use a shared cluster.
        with tempfile.TemporaryDirectory(prefix="executor-kind-") as folder:
            work = Path(folder)
            kubeconfig = work / "kubeconfig"
            cluster = "executor-1053-" + str(os.getpid())
            context = "kind-" + cluster
            kubeenv = {**os.environ, "KUBECONFIG": str(kubeconfig)}
            command(["kind", "create", "cluster", "--name", cluster, "--kubeconfig", str(kubeconfig), "--wait", "120s"], env=kubeenv)
            try:
                self.matrix(work, context, kubeenv)
            finally:
                command(["kind", "delete", "cluster", "--name", cluster], env=kubeenv)

    def matrix(self, work, context, kubeenv):
        helm3 = os.environ.get("HELM3_BIN", "helm3")
        old_root = work / "old"
        old_root.mkdir()
        historical_checkout(old_root)
        tls_root = work / "existing-980-tls"
        tls_root.mkdir()
        historical_checkout(tls_root, BASE_REVISION)
        outcomes = []
        # Use the already reviewed BusyBox image only as a JWT-env probe. No product image changes.
        image = "docker.io/library/busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0"
        command(["docker", "pull", image])
        probe_image = "executor-jwt-probe:1053"
        command(["docker", "tag", image, probe_image])
        command(["kind", "load", "docker-image", probe_image, "--name", context.removeprefix("kind-")])
        sources = (("pre980", old_root, "default", True),
                   ("existing980-tls", tls_root, "prod-tls", False))
        cases = [(scenario, root, profile, literals, path)
                 for scenario, root, profile, literals in sources
                 for path in ("helm3-client", "argo-client", "helm4-server")]
        for scenario, source_root, profile, literals, path in cases:
            # Untreated observations cannot create pods/ReplicaSets in the positive sequence.
            untreated = self.run_case(work, context, kubeenv, probe_image, scenario,
                                      source_root, profile, literals, path, positive=False)
            positive = self.run_case(work, context, kubeenv, probe_image, scenario,
                                     source_root, profile, literals, path, positive=True)
            outcomes.append({"scenario": scenario, "profile": profile, "path": path,
                             "untreated": untreated, **positive})
        self.assertTrue(any(item["untreated"] == "REJECTED_DUAL_FIELD" for item in outcomes), "matrix must reproduce reported defect")
        evidence = {"old_revision": command(GIT + ["rev-parse", "433be51"]).strip(),
                    "existing_980_tls_revision": command(GIT + ["rev-parse", BASE_REVISION]).strip(),
                    "target_revision": command(GIT + ["rev-parse", "HEAD"]).strip(), "paths": outcomes,
                    "mechanism": "pause executor; gated target delivery; atomic JWT env repair; retry rejected delivery; verify before resume",
                    "helm3": command([helm3, "version", "--short"]).strip(),
                    "helm4": command(["helm", "version", "--short"]).strip()}
        evidence["legacy_values_layer"] = "tests/blackbox/fixtures/executor-env-before-980.yaml"
        evidence["legacy_values_sha256"] = hashlib.sha256((ROOT / evidence["legacy_values_layer"]).read_bytes()).hexdigest()
        evidence["probe_upgrade_values_layer"] = UPGRADE_VALUES
        evidence["probe_upgrade_values_sha256"] = hashlib.sha256((ROOT / UPGRADE_VALUES).read_bytes()).hexdigest()
        evidence["probe_upgrade_scope"] = "disposable JWT probe only; explicit authority waiver; no database or backup/parity claim"
        evidence["historical_defaults"] = "no direct issuer/audience; explicit values layer models reported installed state"
        evidence["justification"] = [
            {"scenario": item["scenario"], "path": item["path"], "observed": item["untreated"],
             "step_required": item["untreated"] != "PASS", "paused_delivery_and_atomic_repair": "PASS",
             "positive_sequence_new_replicasets": item["new_replicasets"]}
            for item in outcomes
        ]
        output = Path(os.environ["EXECUTOR_UPGRADE_EVIDENCE"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, indent=2) + "\n")
        print("EXECUTOR_MATRIX_EVIDENCE_SHA256=" + hashlib.sha256(output.read_bytes()).hexdigest())

    def run_case(self, work, context, kubeenv, probe_image, scenario, source_root,
                 profile, literals, path, positive):
        phase = "safe" if positive else "negative"
        namespace = "executor-" + scenario + "-" + path + "-" + phase
        kube = ["kubectl", "--context", context, "-n", namespace]
        command(kube + ["create", "namespace", namespace], env=kubeenv)
        previous = render(source_root, profile, namespace=namespace, legacy_literals=literals)
        objects = render(ROOT, profile, namespace=namespace, upgrade=True)
        old = select(previous, "Deployment", NAME)
        target = select(objects, "Deployment", NAME)
        config = select(objects, "ConfigMap", CONFIG)
        old_probe, new_probe = probe(old, probe_image), probe(target, probe_image)
        if scenario == "existing980-tls":
            self.assertEqual(sum(item["name"] == "KEYCLOAK_JWKS_URL" for item in env(old_probe)), 2)
        chart = work / namespace
        (chart / "templates").mkdir(parents=True)
        (chart / "Chart.yaml").write_text("apiVersion: v2\nname: executor-upgrade-probe\nversion: 0.0.1\n")
        manifest = chart / "templates/executor.yaml"
        manifest.write_text(yaml.safe_dump(old_probe))
        service = select(objects, "Service", NAME)
        (chart / "templates/service.yaml").write_text(yaml.safe_dump(service))
        config_manifest = chart / "templates/config.yaml"
        if not literals:
            config_manifest.write_text(yaml.safe_dump(select(previous, "ConfigMap", CONFIG)))
        helm3 = os.environ.get("HELM3_BIN", "helm3")
        helm_scope = [RELEASE, str(chart), "-n", namespace, "--kube-context", context]
        command([helm3, "install", *helm_scope, "--wait", "--timeout", "120s"], env=kubeenv)
        service_uid = command(kube + ["get", "service", NAME, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
        initial_config_uid = (command(kube + ["get", "configmap", CONFIG, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
                              if not literals else None)
        before = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
        self.assertNotIn("kubectl.kubernetes.io/last-applied-configuration", before["metadata"].get("annotations", {}))
        revision = command(GIT + ["rev-parse", "HEAD"]).strip()
        step = ["python3", str(HELPER), "--revision", revision, "--release", RELEASE,
                "--namespace", namespace, "--context", context]
        for layer in LAYERS[profile]:
            step += ["--values", layer]
        step += ["--values", UPGRADE_VALUES]
        if positive:
            # Set other-manager fields before the safety baseline; those templates
            # still belong to the historical installed state.
            command(kube + ["patch", "deployment", NAME, "--type=merge", "-p", json.dumps({
                "metadata": {"annotations": {"other-manager": "preserve"}},
                "spec": {"replicas": 2, "template": {"metadata": {"annotations": {"rollout-restart": "preserve"}}}},
            })], env=kubeenv)
            command(kube + ["rollout", "status", "deployment/" + NAME, "--timeout=120s"], env=kubeenv)
            before = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            baseline = {item["metadata"]["uid"] for item in json.loads(
                command(kube + ["get", "replicasets", "-o", "json"], env=kubeenv))["items"]}
            deployment_uid = before["metadata"]["uid"]
            created = set()
            def assert_sequence():
                items = json.loads(command(kube + ["get", "replicasets", "-o", "json"], env=kubeenv))["items"]
                created.update(validate_new_replicasets(items, baseline, deployment_uid))
            command(kube + ["rollout", "pause", "deployment/" + NAME], env=kubeenv)
            before = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            # Even nonempty historical TLS data must fail before patch/rollout.
            if scenario == "existing980-tls":
                generation = before["metadata"]["generation"]
                for flags in ([], ["--apply"]):
                    stale_config = subprocess.run(step + flags, capture_output=True, text=True,
                                                  env=kubeenv, timeout=120)
                    self.assertNotEqual(stale_config.returncode, 0, "stale target data must block the helper")
                    current = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
                    self.assertEqual(current["metadata"]["generation"], generation)
                assert_sequence()
        # Deliver the target ConfigMap AND executor together, just as the real
        # chart does. There is no synthetic ConfigMap-only preparation revision.
        # The readiness probe isolates runtime dependencies, not delivery order.
        config_manifest.write_text(yaml.safe_dump(config))
        manifest.write_text(yaml.safe_dump(new_probe))
        argo_manifest = chart / "target.yaml"
        argo_manifest.write_text(yaml.safe_dump_all([config, service, new_probe]))
        apply = (kube + ["apply", "-f", str(argo_manifest)] if path == "argo-client" else
                 [helm3 if path == "helm3-client" else "helm", "upgrade", *helm_scope] +
                 (["--server-side=true"] if path == "helm4-server" else []))
        # A paused Deployment cannot satisfy a rollout wait. Perform the normal
        # adapter apply, then repair/retry before the final readiness gate.
        result = subprocess.run(apply, capture_output=True, text=True, env=kubeenv, timeout=120)
        untreated = delivery_outcome(result, scenario, path)
        live = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
        if result.returncode == 0:
            try:
                migration.validate_env(env(live), CONFIG)
            except ValueError:
                untreated = "ACCEPTED_INVALID_JWT_ENV"
        config_uid = command(kube + ["get", "configmap", CONFIG, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
        if initial_config_uid is not None:
            self.assertEqual(config_uid, initial_config_uid, "target delivery must retain the ConfigMap")
        if positive:
            self.assertTrue(live["spec"].get("paused"), "target delivery must retain the rollout pause")
            assert_sequence()
            command(step, env=kubeenv)  # server-side dry-run
            command(step + ["--apply"], env=kubeenv)
            assert_sequence()
            after = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            migration.validate_env(env(after), CONFIG)
            self.assertEqual(after["spec"]["replicas"], 2)
            self.assertEqual(after["metadata"]["annotations"]["other-manager"], "preserve")
            self.assertEqual(after["spec"]["template"]["metadata"]["annotations"]["rollout-restart"], "preserve")
            generation = after["metadata"]["generation"]
            self.assertIn("UNCHANGED", command(step + ["--apply"], env=kubeenv))
            repeated = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            self.assertEqual(repeated["metadata"]["generation"], generation)
            probe_script = "printf '%s\\n' " + " ".join('"$' + key + '"' for key in migration.JWT_NAMES)
            if result.returncode:
                # The first apply already reconciled the ConfigMap before the
                # executor rejection. Retry the exact target, retaining gates.
                command(apply, env=kubeenv)
            paused = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            self.assertTrue(paused["spec"].get("paused"), "delivery must retain the rollout pause")
            assert_sequence()
            # Reverify/repair after any retry while paused, before a new ReplicaSet.
            command(step, env=kubeenv)
            command(step + ["--apply"], env=kubeenv)
            verified = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            migration.validate_env(env(verified), CONFIG)
            self.assertTrue(verified["spec"].get("paused"))
            assert_sequence()
            command(kube + ["rollout", "resume", "deployment/" + NAME], env=kubeenv)
            command(kube + ["rollout", "status", "deployment/" + NAME, "--timeout=120s"], env=kubeenv)
            assert_sequence()
            self.assertTrue(created, "positive sequence must inspect at least one new ReplicaSet")
            delivered = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            migration.validate_env(env(delivered), CONFIG)
            self.assertEqual(delivered["spec"]["replicas"], 2, "delivery must retain HPA-managed replicas")
            self.assertEqual(delivered["metadata"]["annotations"]["other-manager"], "preserve")
            self.assertEqual(delivered["spec"]["template"]["metadata"]["annotations"]["rollout-restart"], "preserve")
            self.assertTrue(any(item["type"] == "Available" and item["status"] == "True" for item in delivered["status"]["conditions"]))
            resolved = command(kube + ["exec", "deployment/" + NAME, "--", "sh", "-c", probe_script], env=kubeenv).splitlines()
            self.assertTrue(resolved == [config["data"][key] for key in migration.JWT_NAMES], "delivery pod reference resolution mismatch")
            self.assertEqual(command(kube + ["get", "configmap", CONFIG, "-o", "jsonpath={.metadata.uid}"], env=kubeenv), config_uid)
            self.assertEqual(command(kube + ["get", "service", NAME, "-o", "jsonpath={.metadata.uid}"], env=kubeenv), service_uid)
            self.assertIn("UNCHANGED", command(step + ["--apply"], env=kubeenv))
            assert_sequence()
            return {"initial_paused_delivery": untreated,
                    "rejected_delivery_retry": "PASS" if result.returncode else "NOT_REQUIRED",
                    "atomic_step": "PASS", "delivery": "PASS", "paused_delivery_verification": "PASS", "replicaset_safety": "PASS",
                    "new_replicasets": len(created), "retained_hpa_replicas_and_annotations": "PASS"}
        # Negative observations are isolated and never waive a positive safety failure.
        bad = copy.deepcopy(new_probe)
        next(item for item in env(bad) if item["name"] == migration.JWT_NAMES[0])["value"] = "legacy"
        negative = subprocess.run(kube + ["patch", "deployment", NAME, "--type=json", "--dry-run=server",
                                         "--patch-file=/dev/stdin"], input=json.dumps([
            {"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": env(bad)}
        ]), capture_output=True, text=True, env=kubeenv, timeout=60)
        self.assertTrue(rejected_dual_field(negative),
                        "API must reject negative dual-field control")
        stale = subprocess.run(kube + ["patch", "deployment", NAME, "--type=json", "--dry-run=server",
                                      "--patch-file=/dev/stdin"], input=json.dumps([
            {"op": "test", "path": "/metadata/resourceVersion", "value": "stale-version"},
            {"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": env(new_probe)}
        ]), capture_output=True, text=True, env=kubeenv, timeout=60)
        self.assertNotEqual(stale.returncode, 0, "stale resourceVersion must reject before mutation")
        unchanged = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
        self.assertTrue(env(unchanged) == env(live), "negative controls must not change live env")
        return untreated


if __name__ == "__main__":
    unittest.main()
