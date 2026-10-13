{{- define "in-falcone.effectiveApisixRoutes" -}}
{{- $routes := list -}}
{{- /* Helm reuse-values retains the old route array. Migrate only its exact
      legacy SSE entry, keeping all other stored route definitions intact. */ -}}
{{- range .Values.bootstrap.reconcile.apisix.routes -}}
{{- if and (eq .routeId "2016-rt") (eq .name "public-api-realtime-changes") -}}
{{- $legacy := . -}}
{{- range $source, $pattern := dict
  "collection" "^/v1/realtime/workspaces/[^/]+/data/[^/]+/collections/[^/]+/changes$"
  "table" "^/v1/realtime/workspaces/[^/]+/data/[^/]+/schemas/[^/]+/tables/[^/]+/changes$"
-}}
{{- $route := deepCopy $legacy -}}
{{- $name := printf "public-api-realtime-%s-changes" $source -}}
{{- $_ := set $route "routeId" $name -}}
{{- $_ := set $route "name" $name -}}
{{- $_ := set $route "uri" "/v1/realtime/workspaces/*" -}}
{{- $_ := set $route "vars" (list (list "uri" "~~" $pattern)) -}}
{{- $labels := $route.labels | default dict -}}
{{- $_ := set $labels "gateway.in-falcone.io/auth-mode" "query_api_key_sse" -}}
{{- $_ := set $route "labels" $labels -}}
{{- $headers := dict "x-gateway-auth" "${{GATEWAY_SHARED_SECRET}}" -}}
{{- range list "x-auth-subject" "x-actor-username" "x-tenant-id" "x-workspace-id" "x-plan-id" "x-auth-scopes" "x-actor-roles" -}}
{{- $_ := set $headers . "" -}}
{{- end -}}
{{- $_ := set $route.plugins "client-control" (dict "max_body_size" 1024) -}}
{{- $_ := set $route.plugins "request-validation" (dict "header_schema" (dict "type" "object")) -}}
{{- $_ := set $route.plugins "proxy-rewrite" (dict "headers" (dict "set" $headers)) -}}
{{- $routes = append $routes $route -}}
{{- end -}}
{{- else -}}
{{- $routes = append $routes . -}}
{{- end -}}
{{- end -}}
{{- toJson $routes -}}
{{- end -}}
