# In Falcone chart 0.4.7

Release date: superseded by immutable chart 0.4.8. Chart 0.4.7 retained the architecture,
component versions, Falcone main revision `61540248`, and six verified
first-party image digests from chart 0.4.6.

This immutable repair closes the existing-object ownership gate reproduced by
the 0.4.6 live Phase-A apply. The exact fourteen Falcone-owned
`ExternalSecret` declarations already existed with canonical specs but without
Helm release metadata, so Helm refused the first object before advancing the
release revision.

Revision-20 preflight now verifies the exact declaration set, canonical specs,
and complete ownership tuple without reading generated Secret payloads. Apply
validates all fourteen before mutation and adopts only an all-absent tuple using
metadata-only JSON patches guarded by each object's UID and resourceVersion.
Exact already-owned retries are skipped; partial or foreign ownership, spec or
identity drift, and concurrent changes fail closed. The repair never uses broad
`--take-ownership` and never adopts the external ESO controller, CRDs, webhooks,
Services, RBAC, or namespace.

Chart 0.4.6 remains the historical published repair blocked by that ownership
 gate and is not overwritten. Chart 0.4.7 changed no public API, schema, storage,
authorization, image, or runtime contract. Chart 0.4.7 is superseded; chart
0.4.8 is the active repair target.
