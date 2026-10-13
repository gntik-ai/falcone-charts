{{- /* The single executor-authenticated SSE family has the same safety boundary
      in reconciled and standalone routes, including releases with stored values. */ -}}
{{- define "in-falcone.realtimeChangesRoute" -}}
{{- $route := deepCopy . -}}
{{- $_ := set $route "name" "public-api-realtime-changes" -}}
{{- $_ := set $route "uri" "/v1/realtime/workspaces/*" -}}
{{- $_ := set $route "methods" (list "GET" "OPTIONS") -}}
{{- $_ := set $route "vars" (list (list "uri" "~~" "^/v1/realtime/workspaces/[^/]+/data/[^/]+/(collections/[^/]+|schemas/[^/]+/tables/[^/]+)/changes$")) -}}
{{- $labels := $route.labels | default dict -}}
{{- $_ := set $labels "gateway.in-falcone.io/route-kind" "product_api" -}}
{{- $_ := set $labels "gateway.in-falcone.io/family" "realtime-changes" -}}
{{- $_ := set $route "labels" $labels -}}
{{- $plugins := $route.plugins | default dict -}}
{{- $client := index $plugins "client-control" | default dict -}}
{{- $_ := set $client "max_body_size" ($client.max_body_size | default 131072) -}}
{{- $_ := set $plugins "client-control" $client -}}
{{- $_ := set $plugins "proxy-rewrite" (dict "headers" (dict "set" (dict
  "x-tenant-id" "" "x-workspace-id" "" "x-auth-subject" "" "x-actor-roles" ""
  "x-gateway-auth" "${{GATEWAY_SHARED_SECRET}}"
))) -}}
{{- $_ := set $route "plugins" $plugins -}}
{{- toJson $route -}}
{{- end -}}
