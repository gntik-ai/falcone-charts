# In Falcone chart 0.4.8

Chart 0.4.8 is an immutable follow-up to 0.4.7. It preserves the six
approved first-party image digests and all 0.4.7 staging infrastructure fixes.

The revision-20 repair and forward-recovery tools now validate the historical
C-25 webhook signing-key custody contract from Helm revision 20 before any
mutation. They pass explicit legacy custody overrides to every render and
upgrade, including recovery, without reading Secret data or using
`--reuse-values`. A failed pre-hook is resumable only when Helm history proves
revision 20 is deployed and the sole failed revision is the known
`CREDENTIAL_MANAGED_SECRET_MISSING` attempt.
