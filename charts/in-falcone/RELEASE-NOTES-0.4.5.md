# In Falcone chart 0.4.5

Release date: pending publication. Source baseline and the six verified
first-party image digests are identical to chart 0.4.4.

Chart 0.4.5 is an immutable republish of the 0.4.4 staging repair with one
precise correction: the semantic-diff gate now evaluates the exact target
boundary, so an unrelated ESO classification cannot block a valid dry-run.
There is no overwrite of the published 0.4.4 artifact and no API, schema,
storage, migration, authorization, or runtime contract change. Architecture,
component versions, source revision 20, and all six image digests remain
unchanged.

Chart 0.4.3 remains the historical base repair release. Chart 0.4.4 remains
the published image-pinning release; its real dry-run was blocked by the ESO
classification gate. Chart 0.4.5 is the next repair target.
