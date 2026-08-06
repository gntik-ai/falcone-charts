"""Black-box contracts for the public ``in-falcone`` Helm chart."""

from pathlib import Path
import shutil
import subprocess

import pytest
import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CHART_PATH = REPOSITORY_ROOT / "charts" / "in-falcone"


def _render_chart() -> list[dict]:
    helm = shutil.which("helm")
    if helm is None:
        pytest.fail("helm is required to exercise the public chart interface")

    completed = subprocess.run(
        [
            helm,
            "template",
            "bbx-c05",
            str(CHART_PATH),
            "--namespace",
            "bbx-c05",
        ],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, (
        "helm template failed:\n"
        f"stdout:\n{completed.stdout}\n"
        f"stderr:\n{completed.stderr}"
    )
    return [
        document
        for document in yaml.safe_load_all(completed.stdout)
        if isinstance(document, dict)
    ]


# bbx-c05-control-plane-health-probes
# Covers: fn-control-plane-health-probes
# OpenSpec #### Scenario: Control-plane probes use public health endpoints
def test_control_plane_probes_use_named_http_port_and_public_paths() -> None:
    documents = _render_chart()
    matching_deployments = [
        document
        for document in documents
        if document.get("kind") == "Deployment"
        and document.get("metadata", {}).get("name", "").endswith("-control-plane")
    ]

    assert len(matching_deployments) == 1, (
        "expected exactly one rendered Deployment named <release>-control-plane, "
        f"found {len(matching_deployments)}"
    )
    containers = matching_deployments[0]["spec"]["template"]["spec"]["containers"]
    matching_containers = [
        container for container in containers if container.get("name") == "control-plane"
    ]
    assert len(matching_containers) == 1, (
        "expected exactly one control-plane container in the control-plane Deployment, "
        f"found {len(matching_containers)}"
    )
    container = matching_containers[0]
    probe_paths = {
        "livenessProbe": "/livez",
        "readinessProbe": "/readyz",
    }

    for probe_name, expected_path in probe_paths.items():
        http_get = container.get(probe_name, {}).get("httpGet", {})
        assert http_get.get("path") == expected_path
        assert http_get.get("port") == "http"
        assert not str(http_get.get("path", "")).startswith("/internal/")
