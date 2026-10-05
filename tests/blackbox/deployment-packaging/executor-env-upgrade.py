"""#1053 render, atomic patch, and disposable API-server regression evidence."""
import copy
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


def render(root, profile="default", namespace="falcone-upgrade", legacy_literals=False):
    args = ["helm", "template", RELEASE, str(root / "charts/in-falcone"), "-n", namespace]
    for layer in LAYERS[profile]:
        args += ["-f", str(root / layer)]
    if legacy_literals:
        args += ["-f", str(ROOT / "tests/blackbox/fixtures/executor-env-before-980.yaml")]
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


class Offline(unittest.TestCase):
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
                    "mechanism": "atomic JWT env patch before delivery; paused delivery verified before resume",
                    "helm3": command([helm3, "version", "--short"]).strip(),
                    "helm4": command(["helm", "version", "--short"]).strip()}
        evidence["legacy_values_layer"] = "tests/blackbox/fixtures/executor-env-before-980.yaml"
        evidence["legacy_values_sha256"] = hashlib.sha256((ROOT / evidence["legacy_values_layer"]).read_bytes()).hexdigest()
        evidence["historical_defaults"] = "no direct issuer/audience; explicit values layer models reported installed state"
        evidence["justification"] = [
            {"scenario": item["scenario"], "path": item["path"], "observed": item["untreated"],
             "step_required": item["untreated"] != "PASS", "atomic_step_before_delivery": "PASS",
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
        objects = render(ROOT, profile, namespace=namespace)
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
        before = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
        self.assertNotIn("kubectl.kubernetes.io/last-applied-configuration", before["metadata"].get("annotations", {}))
        revision = command(GIT + ["rev-parse", "HEAD"]).strip()
        step = ["python3", str(HELPER), "--revision", revision, "--release", RELEASE,
                "--namespace", namespace, "--context", context]
        for layer in LAYERS[profile]:
            step += ["--values", layer]
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
        # Preparation uses the Helm adapter, retaining the installed executor
        # manifest. Only the target ConfigMap data is delivered in this revision.
        config_manifest.write_text(yaml.safe_dump(config))
        command([helm3, "upgrade", *helm_scope, "--wait", "--timeout", "120s"], env=kubeenv)
        config_uid = command(kube + ["get", "configmap", CONFIG, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
        service_uid = command(kube + ["get", "service", NAME, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
        prepared = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
        self.assertTrue(env(prepared) == env(before), "ConfigMap preparation must hold the installed executor env")
        if positive:
            self.assertTrue(prepared["spec"].get("paused"), "preparation must retain the rollout pause")
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
        # Deliver the target only AFTER the atomic step in the positive sequence.
        manifest.write_text(yaml.safe_dump(new_probe))
        apply = (kube + ["apply", "-f", str(manifest)] if path == "argo-client" else
                 [helm3 if path == "helm3-client" else "helm", "upgrade", *helm_scope] +
                 (["--server-side=true"] if path == "helm4-server" else []))
        if positive:
            command(apply, env=kubeenv)
            paused = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            self.assertTrue(paused["spec"].get("paused"), "delivery must retain the rollout pause")
            assert_sequence()
            # Helm's stored duplicate manifest can still delete a name during
            # delivery. Repair atomically while paused, before any new ReplicaSet.
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
            return {"atomic_step": "PASS", "delivery": "PASS", "paused_delivery_verification": "PASS", "replicaset_safety": "PASS",
                    "new_replicasets": len(created), "retained_hpa_replicas_and_annotations": "PASS"}
        # Negative observations are isolated and never waive a positive safety failure.
        result = subprocess.run(apply, capture_output=True, text=True, env=kubeenv, timeout=120)
        rejected = result.returncode != 0 and "may not be specified when value is not empty" in result.stderr
        duplicate_rejected = (scenario == "existing980-tls" and result.returncode != 0
                              and ("duplicate" in result.stderr.lower() or "$setElementOrder" in result.stderr)
                              and "KEYCLOAK_JWKS_URL" in result.stderr)
        self.assertTrue(result.returncode == 0 or rejected or duplicate_rejected,
                        scenario + "/" + path + ": unexpected failure (payload redacted)")
        live = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
        untreated = "REJECTED_DUAL_FIELD" if rejected else "REJECTED_DUPLICATE_ENV" if duplicate_rejected else "PASS"
        if result.returncode == 0:
            try:
                migration.validate_env(env(live), CONFIG)
            except ValueError:
                untreated = "ACCEPTED_INVALID_JWT_ENV"  # Defect evidence only in this disposable negative namespace.
        bad = copy.deepcopy(new_probe)
        next(item for item in env(bad) if item["name"] == migration.JWT_NAMES[0])["value"] = "legacy"
        negative = subprocess.run(kube + ["patch", "deployment", NAME, "--type=json", "--dry-run=server",
                                         "--patch-file=/dev/stdin"], input=json.dumps([
            {"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": env(bad)}
        ]), capture_output=True, text=True, env=kubeenv, timeout=60)
        self.assertTrue(negative.returncode != 0 and "may not be specified when value is not empty" in negative.stderr,
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
