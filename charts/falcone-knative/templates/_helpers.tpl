{{- define "falcone-knative.labels" -}}
app.kubernetes.io/name: falcone-knative
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.Version | quote }}
app.kubernetes.io/managed-by: Helm
app.kubernetes.io/part-of: falcone-knative
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
falcone.io/knative-owner: {{ .Values.owner | quote }}
{{- end }}

{{- define "falcone-knative.projectorServiceAccountName" -}}
{{- if .Values.projector.serviceAccountName -}}
{{- .Values.projector.serviceAccountName -}}
{{- else -}}
{{- printf "falcone-knative-status-projector-%s" (.Values.owner | sha256sum | trunc 8) -}}
{{- end -}}
{{- end }}

{{- define "falcone-knative.image" -}}
{{- $root := index . 0 -}}
{{- $repository := index . 1 -}}
{{- $digest := index . 2 -}}
{{- if $root.Values.supplyChain.registry -}}
{{- $prefix := trimSuffix "/" $root.Values.supplyChain.registry -}}
{{- $path := $repository -}}
{{- $path = trimPrefix "gcr.io/knative-releases/" $path -}}
{{- $path = trimPrefix "docker.io/" $path -}}
{{- $path = trimPrefix "registry.k8s.io/" $path -}}
{{- printf "%s/%s@%s" $prefix $path $digest -}}
{{- else -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end -}}
{{- end }}

{{- define "falcone-knative.renderStage" -}}
{{- $root := index . 0 -}}
{{- $path := index . 1 -}}
{{- $content := $root.Files.Get $path -}}
{{- $content = replace "__FALCONE_OWNER__" $root.Values.owner $content -}}
{{- if $root.Values.supplyChain.registry -}}
{{- $mirror := printf "%s/" (trimSuffix "/" $root.Values.supplyChain.registry) -}}
{{- $content = replace "gcr.io/knative-releases/" $mirror $content -}}
{{- $content = replace "docker.io/" $mirror $content -}}
{{- $content = replace "registry.k8s.io/" $mirror $content -}}
{{- end -}}
{{- $content -}}
{{- end }}

{{- define "falcone-knative.stageSelected" -}}
{{- $root := index . 0 -}}
{{- $stage := index . 1 -}}
{{- if or (eq $root.Values.lifecycle.installStage "all") (eq $root.Values.lifecycle.installStage $stage) -}}true{{- end -}}
{{- end }}

{{- define "falcone-knative.renderOwnedStage" -}}
{{- $root := index . 0 -}}
{{- $path := index . 1 -}}
{{- $content := include "falcone-knative.renderStage" (list $root $path) -}}
{{ range $document := regexSplit "(?m)^---[[:space:]]*$" $content -1 }}
{{ $object := fromYaml $document }}
{{ if and $object.kind (not (has $object.kind (list "CustomResourceDefinition" "Namespace"))) }}
---
{{ toYaml $object }}
{{ end }}
{{ end }}
{{- end }}
