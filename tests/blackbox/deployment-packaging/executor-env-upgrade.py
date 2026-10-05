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


class Offline(unittest.TestCase):
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
        target = select(render(ROOT), "Deployment", NAME)
        live = copy.deepcopy(target)
        live["metadata"]["resourceVersion"] = "42"
        env(live)[:] = [{"name": key, "value": "old"} for key in migration.JWT_NAMES[:3]]
        original_run, original_argv = migration.run, list(migration.sys.argv)
        revision = "a" * 40
        for failure in ("revision", "dirty", "config", "none"):
            calls = []
            def fake(args, **kwargs):
                calls.append(args)
                if "rev-parse" in args:
                    return ("b" * 40 if failure == "revision" else revision) + "\n"
                if "status" in args:
                    return " M charts/in-falcone/values.yaml" if failure == "dirty" else ""
                if args[0] == "helm":
                    return yaml.safe_dump(target)
                if "configmap" in args:
                    return "MISSING" if failure == "config" else ""
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
        outcomes = []
        # Use the already reviewed BusyBox image only as a JWT-env probe. No product image changes.
        image = "docker.io/library/busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0"
        command(["docker", "pull", image])
        probe_image = "executor-jwt-probe:1053"
        command(["docker", "tag", image, probe_image])
        command(["kind", "load", "docker-image", probe_image, "--name", context.removeprefix("kind-")])
        for path in ("helm3-client", "argo-client", "helm4-server"):
            namespace = "executor-" + path
            kube = ["kubectl", "--context", context, "-n", namespace]
            command(kube + ["create", "namespace", namespace], env=kubeenv)
            old = select(render(old_root, namespace=namespace, legacy_literals=True), "Deployment", NAME)
            objects = render(ROOT, namespace=namespace)
            target = select(objects, "Deployment", NAME)
            config = select(objects, "ConfigMap", CONFIG)
            def probe(deployment):
                result = copy.deepcopy(deployment)
                result["spec"]["replicas"] = 1
                jwt = [item for item in env(result) if item["name"] in migration.JWT_NAMES]
                result["spec"]["template"]["spec"] = {"containers": [{
                    "name": "control-plane-executor", "image": probe_image, "imagePullPolicy": "IfNotPresent",
                    "env": jwt, "command": ["sh", "-c", "sleep 3600"],
                    "readinessProbe": {"exec": {"command": ["sh", "-c",
                        'test -n "$KEYCLOAK_JWKS_URL" && test -n "$KEYCLOAK_ISSUER" && test -n "$KEYCLOAK_AUDIENCE"']}, "periodSeconds": 1},
                }]}
                return result
            old_probe, new_probe = probe(old), probe(target)
            chart = work / path
            (chart / "templates").mkdir(parents=True)
            (chart / "Chart.yaml").write_text("apiVersion: v2\nname: executor-upgrade-probe\nversion: 0.0.1\n")
            manifest = chart / "templates/executor.yaml"
            manifest.write_text(yaml.safe_dump(old_probe))
            service = select(objects, "Service", NAME)
            (chart / "templates/service.yaml").write_text(yaml.safe_dump(service))
            helm3 = os.environ.get("HELM3_BIN", "helm3")
            command([helm3, "install", RELEASE, str(chart), "-n", namespace, "--kube-context", context, "--wait", "--timeout", "120s"], env=kubeenv)
            before = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            self.assertNotIn("kubectl.kubernetes.io/last-applied-configuration", before["metadata"].get("annotations", {}))
            # ConfigMap is made available before any reference-only pod template is submitted.
            command(kube + ["create", "-f", "-"], input=json.dumps(config), env=kubeenv)
            config_uid = command(kube + ["get", "configmap", CONFIG, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
            service_uid = command(kube + ["get", "service", NAME, "-o", "jsonpath={.metadata.uid}"], env=kubeenv)
            manifest.write_text(yaml.safe_dump(new_probe))
            apply = (kube + ["apply", "-f", str(manifest)] if path == "argo-client" else
                     [helm3 if path == "helm3-client" else "helm", "upgrade", RELEASE, str(chart),
                      "-n", namespace, "--kube-context", context] +
                     (["--server-side=true"] if path == "helm4-server" else []))
            result = subprocess.run(apply, capture_output=True, text=True, env=kubeenv, timeout=120)
            rejected = result.returncode != 0 and "may not be specified when value is not empty" in result.stderr
            self.assertTrue(result.returncode == 0 or rejected, path + ": unexpected failure (payload redacted)")
            outcomes.append({"path": path, "untreated": "REJECTED_DUAL_FIELD" if rejected else "PASS"})
            live = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            # Server-side negative control independently rejects an actual dual-field patch.
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
            # Add other-manager fields after untreated apply; the migration must preserve them.
            command(kube + ["patch", "deployment", NAME, "--type=merge", "-p", json.dumps({
                "metadata": {"annotations": {"other-manager": "preserve"}},
                "spec": {"replicas": 2, "template": {"metadata": {"annotations": {"rollout-restart": "preserve"}}}},
            })], env=kubeenv)
            revision = command(GIT + ["rev-parse", "HEAD"]).strip()
            step = ["python3", str(HELPER), "--revision", revision, "--release", RELEASE,
                    "--namespace", namespace, "--context", context, "--apply"]
            command(step, env=kubeenv)
            after = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            migration.validate_env(env(after), CONFIG)
            self.assertEqual(after["spec"]["replicas"], 2)
            self.assertEqual(after["metadata"]["annotations"]["other-manager"], "preserve")
            self.assertEqual(after["spec"]["template"]["metadata"]["annotations"]["rollout-restart"], "preserve")
            generation = after["metadata"]["generation"]
            self.assertIn("UNCHANGED", command(step, env=kubeenv))
            repeated = json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))
            self.assertEqual(repeated["metadata"]["generation"], generation)
            self.assertEqual(command(kube + ["get", "configmap", CONFIG, "-o", "jsonpath={.metadata.uid}"], env=kubeenv), config_uid)
            self.assertEqual(command(kube + ["get", "service", NAME, "-o", "jsonpath={.metadata.uid}"], env=kubeenv), service_uid)
            self.assertTrue(any(item["type"] == "Available" and item["status"] == "True" for item in repeated["status"]["conditions"]))
            # Read pod env without printing it: all five must resolve to the ConfigMap.
            probe_script = "printf '%s\\n' " + " ".join('"$' + key + '"' for key in migration.JWT_NAMES)
            resolved = command(kube + ["exec", "deployment/" + NAME, "--", "sh", "-c", probe_script], env=kubeenv).splitlines()
            self.assertTrue(resolved == [config["data"][key] for key in migration.JWT_NAMES], "pod reference resolution mismatch")
            outcomes[-1]["atomic_step"] = "PASS"
            # Retry the same failed delivery path after migration, not just the helper.
            command(apply, env=kubeenv)
            command(kube + ["rollout", "status", "deployment/" + NAME, "--timeout=120s"], env=kubeenv)
            migration.validate_env(env(json.loads(command(kube + ["get", "deployment", NAME, "-o", "json"], env=kubeenv))), CONFIG)
            outcomes[-1]["retry"] = "PASS"
        self.assertTrue(any(item["untreated"] == "REJECTED_DUAL_FIELD" for item in outcomes), "matrix must reproduce reported defect")
        evidence = {"old_revision": command(GIT + ["rev-parse", "433be51"]).strip(),
                    "target_revision": command(GIT + ["rev-parse", "HEAD"]).strip(), "paths": outcomes,
                    "mechanism": "atomic JWT env patch; preserves live replicas and annotations",
                    "helm3": command([helm3, "version", "--short"]).strip(),
                    "helm4": command(["helm", "version", "--short"]).strip()}
        evidence["legacy_values_layer"] = "tests/blackbox/fixtures/executor-env-before-980.yaml"
        evidence["legacy_values_sha256"] = hashlib.sha256((ROOT / evidence["legacy_values_layer"]).read_bytes()).hexdigest()
        evidence["historical_defaults"] = "no direct issuer/audience; explicit values layer models reported installed state"
        output = Path(os.environ["EXECUTOR_UPGRADE_EVIDENCE"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, indent=2) + "\n")
        print("EXECUTOR_MATRIX_EVIDENCE_SHA256=" + hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
