{{/* The umbrella owns this config; dependency values and user env lists stay untouched. */}}
{{- define "in-falcone.largeTasks.config" -}}
{{- $largeTasks := .Values.largeTasks | default dict -}}
{{- $probe := dig "isolationProbe" dict $largeTasks -}}
{{- $profiles := tpl (toYaml (dig "profiles" dict $largeTasks)) . | fromYaml -}}
{{- toJson (dict
  "namespace" (printf "%s-large-tasks" .Release.Name)
  "platformNamespace" .Release.Namespace
  "openshiftRestricted" (dig "podSecurity" "openshiftRestricted" false (.Values.global | default dict))
  "finishedTtlSeconds" (dig "finishedTtlSeconds" 3600 $largeTasks)
  "claimRetentionSeconds" (dig "claimRetentionSeconds" 604800 $largeTasks)
  "isolationRecheckSeconds" (dig "isolationRecheckSeconds" 86400 $largeTasks)
  "isolationProbeImage" (dig "image" "" $probe)
  "isolationProbeRunAsUser" (dig "runAsUser" 65532 $probe)
  "nodes" (dig "nodes" (list) $largeTasks)
  "approvedImages" (dig "approvedImages" (list) $largeTasks)
  "approvedSandboxRuntimeClasses" (dig "approvedSandboxRuntimeClasses" (list) $largeTasks)
  "profiles" $profiles) -}}
{{- end -}}
