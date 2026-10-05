#!/usr/bin/env python3
"""One-time #1053 JWT env transition; no Secret reads or payload logging."""
import argparse
import copy
import json
from pathlib import Path
import re
import subprocess
import sys

import yaml

JWT_NAMES = (
    "KEYCLOAK_JWKS_URL", "KEYCLOAK_ISSUER", "KEYCLOAK_AUDIENCE",
    "KEYCLOAK_TENANT_AUDIENCE", "KEYCLOAK_ENFORCE_TENANT_AUDIENCE",
)


def validate_env(env, config_name):
    for entry in env:
        if "value" in entry and "valueFrom" in entry:
            raise ValueError("EXECUTOR_ENV_DUAL_FIELD")
    for name in JWT_NAMES:
        entries = [entry for entry in env if entry.get("name") == name]
        if len(entries) != 1:
            raise ValueError("EXECUTOR_ENV_DUPLICATE_OR_MISSING")
        entry = entries[0]
        if "value" in entry or entry.get("valueFrom") != {
            "configMapKeyRef": {"name": config_name, "key": name}
        }:
            raise ValueError("EXECUTOR_ENV_REFERENCE_REQUIRED")


def migration_patch(live, target, config_name):
    containers = live["spec"]["template"]["spec"]["containers"]
    wanted = target["spec"]["template"]["spec"]["containers"]
    expected = next(item for item in wanted if item["name"] == "control-plane-executor")
    validate_env(expected["env"], config_name)
    index = next(i for i, item in enumerate(containers) if item["name"] == expected["name"])
    before = containers[index].get("env", [])
    jwt = [copy.deepcopy(item) for item in expected["env"] if item["name"] in JWT_NAMES]
    # Preserve every non-JWT env entry and every other live Deployment field.
    after = [copy.deepcopy(item) for item in before if item.get("name") not in JWT_NAMES] + jwt
    validate_env(after, config_name)
    if [item for item in before if item.get("name") in JWT_NAMES] == jwt:
        return []
    return [
        {"op": "test", "path": "/metadata/resourceVersion", "value": live["metadata"]["resourceVersion"]},
        {"op": "replace" if "env" in containers[index] else "add",
         "path": f"/spec/template/spec/containers/{index}/env", "value": after},
    ]


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=360, **kwargs)
    if result.returncode:
        # Helm/kubectl failures can contain env or configuration; never echo them.
        raise ValueError("EXECUTOR_UPGRADE_COMMAND_FAILED")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("revision", "release", "namespace", "context"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--values", action="append", default=[])
    parser.add_argument("--apply", action="store_true", help="default is server-side dry-run")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    git = ["git", "-c", f"safe.directory={root}", "-C", str(root)]
    head = run(git + ["rev-parse", "HEAD"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision) or args.revision != head:
        raise ValueError("EXECUTOR_UPGRADE_REVISION_MISMATCH")
    paths = ["charts/in-falcone"]
    for value in args.values:
        path = (root / value).resolve()
        if not path.is_file() or not path.is_relative_to(root):
            raise ValueError("EXECUTOR_UPGRADE_VALUES_INVALID")
        relative = str(path.relative_to(root))
        run(git + ["ls-files", "--error-unmatch", "--", relative])
        paths.append(relative)
    if run(git + ["status", "--porcelain", "--untracked-files=all", "--", *paths]).strip():
        raise ValueError("EXECUTOR_UPGRADE_DIRTY_RENDER_INPUTS")
    command = ["helm", "template", args.release, str(root / "charts/in-falcone"),
               "--namespace", args.namespace, "--is-upgrade"]
    for value in args.values:
        command += ["-f", str(root / value)]
    objects = list(yaml.safe_load_all(run(command)))
    name = f"{args.release}-control-plane-executor"
    targets = [item for item in objects if item and item.get("kind") == "Deployment"
               and item["metadata"]["name"] == name]
    if len(targets) != 1:
        raise ValueError("EXECUTOR_UPGRADE_TARGET_INVALID")
    config_name = f"{args.release}-executor-jwt-config"
    kube = ["kubectl", "--context", args.context, "--namespace", args.namespace]
    # Only print a boolean from the ConfigMap; never retrieve its payload into evidence.
    checks = "".join('{{if not (index .data "' + key + '")}}MISSING{{end}}' for key in JWT_NAMES)
    if run(kube + ["get", "configmap", config_name, "-o", "go-template=" + checks]).strip():
        raise ValueError("EXECUTOR_UPGRADE_CONFIG_NOT_READY")
    live = json.loads(run(kube + ["get", "deployment", name, "-o", "json"]))
    patch = migration_patch(live, targets[0], config_name)
    if patch:
        command = kube + ["patch", "deployment", name, "--type=json", "--patch-file=/dev/stdin"]
        if not args.apply:
            command += ["--dry-run=server"]
        run(command, input=json.dumps(patch))
    if args.apply:
        run(kube + ["rollout", "status", f"deployment/{name}", "--timeout=300s"])
        after = json.loads(run(kube + ["get", "deployment", name, "-o", "json"]))
        if migration_patch(after, targets[0], config_name):
            raise ValueError("EXECUTOR_UPGRADE_VERIFY_FAILED")
        if after["spec"].get("replicas") != live["spec"].get("replicas") or any(
            after["metadata"].get("annotations", {}).get(key) != value
            for key, value in live["metadata"].get("annotations", {}).items()
            if key != "deployment.kubernetes.io/revision"
        ) or after["spec"]["template"]["metadata"].get("annotations", {}) != live["spec"]["template"]["metadata"].get("annotations", {}):
            raise ValueError("EXECUTOR_UPGRADE_LIVE_STATE_CHANGED")
    print("EXECUTOR_UPGRADE_" + ("UNCHANGED" if not patch else "APPLIED" if args.apply else "DRY_RUN_OK"))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, StopIteration, subprocess.TimeoutExpired, OSError, yaml.YAMLError):
        print("EXECUTOR_UPGRADE_FAILED; inspect inputs and live state without logging payloads", file=sys.stderr)
        sys.exit(1)
