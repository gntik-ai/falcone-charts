# Falcone Charts

This repository contains the Helm deployment packaging for Falcone. Application
source code and container image publishing remain in
[gntik-ai/falcone](https://github.com/gntik-ai/falcone).

The umbrella chart is `charts/in-falcone`. Clone this repository as a sibling
of the application repository when using Falcone's development and validation
tooling:

```bash
git clone https://github.com/gntik-ai/falcone-charts.git ../falcone-charts
helm upgrade --install falcone ../falcone-charts/charts/in-falcone \
  --namespace falcone --create-namespace
```

The chart-release workflow packages `charts/in-falcone` and publishes it as an
OCI artifact at `oci://ghcr.io/gntik-ai/charts/in-falcone`. Releases must use a
new `version` in `charts/in-falcone/Chart.yaml`.

## History

Chart and deployment-value history was extracted from
[gntik-ai/falcone](https://github.com/gntik-ai/falcone) with `git filter-repo`.
The retained commits preserve the evolution of the moved paths while excluding
application source files from this repository.
