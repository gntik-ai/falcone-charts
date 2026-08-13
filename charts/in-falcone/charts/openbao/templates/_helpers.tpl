{{- define "openbao.namespace" -}}
{{- .Values.openbao.namespace | default "secret-store" -}}
{{- end -}}

{{- define "openbao.serviceHost" -}}
{{- printf "openbao.%s.svc.cluster.local" (include "openbao.namespace" .) -}}
{{- end -}}

{{- define "openbao.internalServiceHost" -}}
{{- printf "openbao-internal.%s.svc.cluster.local" (include "openbao.namespace" .) -}}
{{- end -}}

{{- define "openbao.address" -}}
{{- printf "https://%s:%v" (include "openbao.serviceHost" .) (.Values.openbao.service.port | default 8200) -}}
{{- end -}}

{{- define "openbao.clusterAddress" -}}
{{- printf "https://$(HOSTNAME).%s:%v" (include "openbao.internalServiceHost" .) (.Values.openbao.service.clusterPort | default 8201) -}}
{{- end -}}

{{- define "openbao.normalizeRepository" -}}
{{- $repository := .repository -}}
{{- $globalRegistry := trimSuffix "/" (default "" .Values.global.imageRegistry) -}}
{{- if or (eq $globalRegistry "") (eq $repository $globalRegistry) (hasPrefix (printf "%s/" $globalRegistry) $repository) -}}
{{- $repository -}}
{{- else -}}
{{- $segments := splitList "/" $repository -}}
{{- $first := first $segments -}}
{{- $hasRegistry := or (contains "." $first) (contains ":" $first) (eq $first "localhost") -}}
{{- if and $hasRegistry (gt (len $segments) 1) -}}
{{- printf "%s/%s" $globalRegistry (join "/" (rest $segments)) -}}
{{- else -}}
{{- printf "%s/%s" $globalRegistry $repository -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openbao.image" -}}
{{- $repo := include "openbao.normalizeRepository" (dict "Values" .root.Values "repository" .image.repository) -}}
{{- if .image.digest -}}
{{- printf "%s@%s" $repo .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo .image.tag -}}
{{- end -}}
{{- end -}}
{{- define "openbao.imagePullSecrets" -}}
{{- $secrets := list -}}
{{- range (default (list) .Values.global.imagePullSecrets) -}}
  {{- if kindIs "map" . -}}
    {{- $secrets = append $secrets .name -}}
  {{- else -}}
    {{- $secrets = append $secrets . -}}
  {{- end -}}
{{- end -}}
{{- range (default (list) .Values.global.privateRegistry.pullSecretNames) -}}
  {{- $secrets = append $secrets . -}}
{{- end -}}
{{- $secrets = $secrets | uniq -}}
{{- if gt (len $secrets) 0 }}
imagePullSecrets:
{{- range $secrets }}
  - name: {{ . }}
{{- end }}
{{- end -}}
{{- end -}}

{{/*
Canonical OpenBao policy sources. Both the durable ConfigMaps and the isolated
forced-recovery snapshots include these helpers so policy bytes cannot drift
between fresh install, routine reconciliation and package-bound recovery.
*/}}
{{- define "openbao.policy.platform" -}}
path "secret/data/platform/*" {
  capabilities = ["read"]
}
path "secret/metadata/platform/*" {
  capabilities = ["list", "read"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
{{- end -}}

{{- define "openbao.policy.authReconcile" -}}
path "auth/kubernetes/config" { capabilities = ["read", "update"] }
path "auth/kubernetes/role/{{ .Values.openbao.authReconcile.roleName }}" { capabilities = ["read", "update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
path "sys/policies/acl" { capabilities = ["list"] }
{{- end -}}
