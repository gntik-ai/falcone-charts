# Control-plane health probes

Audience: platform operators/SREs and release engineers responsible for P18 orchestration behavior.

The `controlPlane` component enables two HTTP checks by default:

| Kubernetes field | Path | Named port | Meaning |
| --- | --- | --- | --- |
| `livenessProbe` | `/livez` | `http` (8080) | Process/listener health only; dependency loss does not request a restart. |
| `readinessProbe` | `/readyz` | `http` (8080) | Schema and PostgreSQL readiness; failure removes the Pod from service endpoints. |

The probes intentionally do not target `/healthz` or any `/internal/*` diagnostic route. The
control-plane image must include the matching C-05 runtime before these chart defaults are rolled
out. A mixed version with an older image will fail its probes because the older runtime has no
`/livez` handler.

Render and inspect the values without applying them to a cluster:

```bash
helm lint charts/in-falcone
helm template falcone charts/in-falcone --namespace falcone > /tmp/falcone-rendered.yaml
bash tests/blackbox/run.sh
```

Expected result: lint and the black-box suite exit zero; the rendered `falcone-control-plane`
Deployment uses `/livez` and `/readyz` on the named `http` port. The test is render-only and does
not contact Kubernetes.

To roll back, revert the two `controlPlane` probe blocks together with the matching runtime change.
No datastore migration or cleanup is involved. A live rollout and recovery rehearsal were not run
as part of C-05.
