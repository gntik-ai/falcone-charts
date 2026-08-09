# in-falcone 0.4.9

## Immutable staging repair storage preservation

Revision-20 repair and forward-recovery tooling now targets chart 0.4.9 and
validates the exact failed revision-22 / deployed revision-20 history before
mutation. Render, diff, and upgrade operations carry explicit non-secret
storage preservation values for the four standalone 10Gi `local-path` PVCs
and the SeaweedFS filer/master 10Gi `hcloud-volumes` claims. Any metadata or
history drift fails closed; Helm `--reuse-values` is never used.

The 0.4.8 package and release notes remain unchanged. Application image
digests are unchanged.
