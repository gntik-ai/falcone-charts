#!/usr/bin/env python3
"""Fail-closed, offline validation for the packaged falcone-knative bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml


DIGEST_REF = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")
TAG_BEFORE_DIGEST = re.compile(r":[^/@]+@sha256:")
REVISION = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"}
ADMISSION_KINDS = {"MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"}
FORBIDDEN_KINDS = {"ClusterServiceVersion", "KnativeServing", "Operator", "OperatorGroup", "Subscription", "SecurityContextConstraints"}
EXPECTED_STAGES = [
    "bundle/stages/01-crds.yaml",
    "bundle/stages/02-foundation.yaml",
    "bundle/stages/03-webhook-backend.yaml",
    "bundle/stages/04-admissionregistration.yaml",
    "bundle/stages/05-serving-controllers.yaml",
    "bundle/stages/06-kourier.yaml",
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def documents(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [value for value in yaml.safe_load_all(handle) if isinstance(value, dict)]


def pod_spec(document: dict) -> dict | None:
    kind = document.get("kind")
    if kind in {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"}:
        return document.get("spec", {}).get("template", {}).get("spec")
    if kind == "Job":
        return document.get("spec", {}).get("template", {}).get("spec")
    if kind == "CronJob":
        return document.get("spec", {}).get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec")
    return None


def image_values(value: object, key: str = "") -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for child_key, child in value.items():
            found.extend(image_values(child, child_key))
    elif isinstance(value, list):
        for child in value:
            found.extend(image_values(child, key))
    elif isinstance(value, str) and (key == "image" or key.endswith("-image")) and "/" in value:
        found.append(value)
    return found


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chart", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()

    chart = args.chart.resolve()
    errors: list[str] = []
    provenance_path = chart / "provenance/provenance-lock.json"
    image_lock_path = chart / "provenance/image-lock.json"
    license_inventory_path = chart / "provenance/license-inventory.json"
    sbom_path = chart / "provenance/sbom.cdx.json"
    for path in [provenance_path, image_lock_path, license_inventory_path, sbom_path]:
        require(path.is_file(), f"required provenance artifact is missing: {path.relative_to(chart)}", errors)
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1

    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    image_lock = json.loads(image_lock_path.read_text(encoding="utf-8"))
    licenses = json.loads(license_inventory_path.read_text(encoding="utf-8"))
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))

    require(provenance.get("schemaVersion") == "falcone.knative-provenance/v1", "invalid provenance schemaVersion", errors)
    require(provenance.get("bundleVersion") == "1.22.1", "bundle version must be 1.22.1", errors)
    support = provenance.get("support", {})
    require(support.get("kubernetes") == "1.34", "support lock must name Kubernetes 1.34", errors)
    require(support.get("openshift") == "4.21", "support lock must name OpenShift 4.21", errors)
    require(support.get("securityProfile") == "restricted-v2", "support lock must name restricted-v2", errors)
    require("not the Red Hat-supported" in support.get("boundary", ""), "support boundary must distinguish raw upstream from Red Hat Serverless", errors)

    original_records: list[dict] = []
    for component in ("serving", "kourier"):
        upstream = provenance.get("upstream", {}).get(component, {})
        require(upstream.get("release") == "knative-v1.22.1", f"{component} release is not locked to 1.22.1", errors)
        require(bool(REVISION.fullmatch(upstream.get("tagObject", ""))), f"{component} annotated tag object is missing", errors)
        require(bool(REVISION.fullmatch(upstream.get("sourceRevision", ""))), f"{component} source revision is missing", errors)
        require(bool(SHA256.fullmatch(upstream.get("releaseChecksumAssetSha256", ""))), f"{component} release checksum asset digest is missing", errors)
        original_records.extend(upstream.get("originalManifests", []))

    for record in [*original_records, *provenance.get("patchedManifests", []), *provenance.get("artifacts", [])]:
        relative = record.get("path", "")
        expected = record.get("sha256", "")
        path = chart / relative
        require(bool(relative) and path.is_file(), f"locked artifact is missing: {relative or '<empty path>'}", errors)
        require(bool(SHA256.fullmatch(expected)), f"locked artifact has an invalid SHA-256: {relative}", errors)
        if path.is_file() and SHA256.fullmatch(expected):
            require(digest(path) == expected, f"checksum mismatch: {relative}", errors)

    patched_paths = [record.get("path") for record in provenance.get("patchedManifests", [])]
    require(patched_paths == EXPECTED_STAGES, "patched stage inventory or deterministic order is incomplete", errors)
    for path in EXPECTED_STAGES:
        require((chart / path).is_file(), f"required stage is missing: {path}", errors)

    all_documents: list[dict] = []
    manifest_images: list[str] = []
    for relative in EXPECTED_STAGES:
        path = chart / relative
        if not path.is_file():
            continue
        stage_documents = documents(path)
        all_documents.extend(stage_documents)
        manifest_images.extend(image_values(stage_documents))
        text = path.read_text(encoding="utf-8")
        require(not re.search(r"runAs(?:User|Group):\s*65534", text), f"fixed UID/GID remains in {relative}", errors)

    require(all(document.get("kind") == "CustomResourceDefinition" for document in documents(chart / EXPECTED_STAGES[0])), "stage 01 may contain only CRDs", errors)
    foundation_kinds = {document.get("kind") for document in documents(chart / EXPECTED_STAGES[1])}
    require(not (foundation_kinds & (WORKLOAD_KINDS | ADMISSION_KINDS)), "foundation stage contains a workload or AdmissionRegistration object", errors)
    webhook_documents = documents(chart / EXPECTED_STAGES[2])
    require(sum(document.get("kind") == "Deployment" and document.get("metadata", {}).get("name") == "webhook" for document in webhook_documents) == 1, "webhook backend stage lacks exactly one webhook Deployment", errors)
    require(not any(document.get("kind") in ADMISSION_KINDS for document in webhook_documents), "webhook backend stage contains AdmissionRegistration", errors)
    require(len(documents(chart / EXPECTED_STAGES[3])) == 3 and all(document.get("kind") in ADMISSION_KINDS for document in documents(chart / EXPECTED_STAGES[3])), "admission stage must contain exactly three configurations", errors)

    for document in all_documents:
        kind = document.get("kind", "")
        name = document.get("metadata", {}).get("name", "<unnamed>")
        require(kind not in FORBIDDEN_KINDS, f"forbidden kind in patched bundle: {kind}/{name}", errors)
        spec = pod_spec(document)
        if not spec:
            continue
        pod_security = spec.get("securityContext", {})
        for container in [*spec.get("initContainers", []), *spec.get("containers", [])]:
            security = container.get("securityContext", {})
            prefix = f"{kind}/{name}/{container.get('name', '<unnamed>')}"
            require(security.get("runAsNonRoot", pod_security.get("runAsNonRoot")) is True, f"{prefix} is not non-root", errors)
            require(security.get("allowPrivilegeEscalation") is False, f"{prefix} allows privilege escalation", errors)
            seccomp = security.get("seccompProfile", pod_security.get("seccompProfile", {}))
            require(seccomp.get("type") == "RuntimeDefault", f"{prefix} lacks RuntimeDefault seccomp", errors)
            require("ALL" in security.get("capabilities", {}).get("drop", []), f"{prefix} does not drop ALL capabilities", errors)
            require("runAsUser" not in security and "runAsGroup" not in security, f"{prefix} fixes a UID/GID", errors)

    for reference in manifest_images:
        require(bool(DIGEST_REF.fullmatch(reference)), f"mutable or malformed staged image: {reference}", errors)
        require(not TAG_BEFORE_DIGEST.search(reference), f"tag retained before digest: {reference}", errors)

    values = yaml.safe_load((chart / "values.yaml").read_text(encoding="utf-8"))
    for image_key in ("image", "metricsImage"):
        image = values.get("projector", {}).get(image_key, {})
        manifest_images.append(f"{image.get('repository', '')}@{image.get('digest', '')}")
    locked_images = image_lock.get("images", [])
    locked_sources = {entry.get("source") for entry in locked_images}
    require(image_lock.get("schemaVersion") == "falcone.image-lock/v1", "invalid image-lock schema", errors)
    require(image_lock.get("rewrite", {}).get("digestPreserved") is True, "image rewrite does not promise digest preservation", errors)
    require(image_lock.get("rewrite", {}).get("tagsAllowed") is False, "image lock permits tags", errors)
    require(set(manifest_images) == locked_sources, "complete image lock does not exactly match staged and projector images", errors)
    for image in locked_images:
        source = image.get("source", "")
        mirror_repository = image.get("mirrorRepository", "")
        require(bool(DIGEST_REF.fullmatch(source)), f"locked image is mutable or malformed: {source}", errors)
        require(bool(mirror_repository) and not re.match(r"^(?:docker|gcr|ghcr|quay)\.io/|^registry\.k8s\.io/", mirror_repository), f"mirror path retains a public registry: {mirror_repository}", errors)
        require(source.endswith("@" + image.get("digest", "")), f"source and digest disagree for {image.get('name')}", errors)

    require(licenses.get("schemaVersion") == "falcone.license-inventory/v1", "invalid license inventory schema", errors)
    require(len(licenses.get("components", [])) >= 5, "license inventory is incomplete", errors)
    require(sbom.get("bomFormat") == "CycloneDX" and sbom.get("specVersion") == "1.6", "invalid CycloneDX SBOM", errors)
    sbom_names = {component.get("name") for component in sbom.get("components", [])}
    require({entry.get("name") for entry in locked_images}.issubset(sbom_names), "SBOM omits a locked image", errors)

    executable_record = provenance.get("lifecycleExecutable", {})
    require(executable_record.get("name") == "falcone-knative", "lifecycle executable basename is not locked", errors)
    require(bool(SHA256.fullmatch(executable_record.get("sha256", ""))), "lifecycle executable SHA-256 is missing", errors)
    require(values.get("status", {}).get("lifecycleExecutable", {}).get("sha256") == executable_record.get("sha256"), "status default and provenance executable digests differ", errors)
    require(values.get("status", {}).get("state") != "compatible", "render defaults may not claim compatibility", errors)
    require(values.get("lifecycle", {}).get("smokeVerified") is False, "render defaults may not claim smoke verification", errors)
    executable = args.executable
    if executable is None:
        candidate = chart.parents[1] / "bin/falcone-knative"
        executable = candidate if candidate.is_file() else None
    if executable is not None:
        require(executable.name == "falcone-knative", "lifecycle executable basename must be falcone-knative", errors)
        require(digest(executable) == executable_record.get("sha256"), "repository executable digest does not match provenance", errors)

    if errors:
        print("falcone-knative bundle validation FAILED", file=sys.stderr)
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"falcone-knative bundle 1.22.1 validated: {len(all_documents)} staged objects, {len(locked_images)} immutable images")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

