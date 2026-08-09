# In Falcone chart 0.4.6

Release date: pending publication. Chart 0.4.6 retains the same architecture,
component versions, source revision, and six verified first-party image
digests as chart 0.4.5.

This immutable repair corrects the release gate's dependency-version boundary:
live pre-mutation validation previously parsed a nested dependency as `0.2.2`
instead of evaluating the exact chart target. The correction is limited to
that semantic boundary. There is no overwrite of the published 0.4.5 artifact
and no API, schema, storage, migration, authorization, or runtime contract
change.

Chart 0.4.5 remains the historical published repair whose live apply was
blocked by nested-version parsing. Chart 0.4.6 is the next active repair
target.
