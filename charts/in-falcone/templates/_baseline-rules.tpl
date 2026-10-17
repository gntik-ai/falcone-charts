{{- /* Bump falcone-baseline-v1 in component-wrapper/workload.yaml when these rules change. */ -}}
{{- define "in-falcone.baselineLatencyThreshold" -}}
{{- $alerts := get (.Values.observability | default dict) "alerts" | default dict -}}
{{- $threshold := dig "latencyThresholdSeconds" 1 $alerts | toString -}}
{{- if not (has $threshold (list "0.25" "0.5" "1" "2.5" "5" "10")) -}}
  {{- fail "observability.alerts.latencyThresholdSeconds must be one of 0.25, 0.5, 1, 2.5, 5 or 10" -}}
{{- end -}}
{{- $threshold -}}
{{- end -}}

{{- define "in-falcone.baselineRules" -}}
{{- $alerts := get (.Values.observability | default dict) "alerts" | default dict -}}
{{- $errorRatio := dig "errorRatio" 0.05 $alerts -}}
{{- $threshold := include "in-falcone.baselineLatencyThreshold" . -}}
{{- $cpSel := "job=\"falcone-control-plane\"" -}}
{{- $exSel := "job=\"falcone-control-plane-executor\"" -}}
{{- if (dig "serviceAccount" "automountToken" false (.Values.observability | default dict)) -}}
  {{- $cp := dig "wrapper" "componentId" "control-plane" (.Values.controlPlane | default dict) | trunc 63 | trimSuffix "-" -}}
  {{- $ex := dig "wrapper" "componentId" "control-plane-executor" (.Values.controlPlaneExecutor | default dict) | trunc 63 | trimSuffix "-" -}}
  {{- $cpSel = printf "job=\"falcone-pods\",component=%s" ($cp | quote) -}}
  {{- $exSel = printf "job=\"falcone-pods\",component=%s" ($ex | quote) -}}
{{- end -}}
- name: falcone-baseline
  rules:
    - alert: FalconeScrapeTargetDown
      expr: 'up{job=~"falcone-.+"} == 0'
      for: 5m
      labels: {severity: warning}
      annotations:
        summary: A Falcone scrape target is down
    - alert: FalconeControlPlaneUnavailable
      expr: {{ printf "absent(up{%s} == 1)" $cpSel | quote }}
      for: 5m
      labels: {severity: critical}
      annotations:
        summary: No control-plane metrics target is up
    - alert: FalconeExecutorUnavailable
      expr: {{ printf "absent(up{%s} == 1)" $exSel | quote }}
      for: 5m
      labels: {severity: critical}
      annotations:
        summary: No control-plane-executor metrics target is up
    - alert: FalconeHighErrorRatio
      expr: {{ printf "sum by (component) (rate(falcone_http_requests_total{status=~\"5..\"}[5m])) / sum by (component) (rate(falcone_http_requests_total[5m])) > %v" $errorRatio | quote }}
      for: 10m
      labels: {severity: warning}
      annotations:
        summary: Falcone HTTP 5xx ratio is above the threshold
    - alert: FalconeGatewayHighErrorRatio
      expr: {{ printf "sum(rate(apisix_http_status{code=~\"5..\"}[5m])) / sum(rate(apisix_http_status[5m])) > %v" $errorRatio | quote }}
      for: 10m
      labels: {severity: warning}
      annotations:
        summary: Gateway 5xx ratio is above the threshold
    - alert: FalconeLatencyObjectiveBreach
      expr: {{ printf "1 - (sum by (component) (rate(falcone_http_request_duration_seconds_bucket{le=~\"%s(\\\\.0)?\"}[30m])) / sum by (component) (rate(falcone_http_request_duration_seconds_count[30m]))) > (1 - %v)" $threshold (dig "latencyObjective" 0.95 $alerts) | quote }}
      for: 15m
      labels: {severity: warning}
      annotations:
        summary: Too many Falcone requests are slower than the latency threshold
    - alert: FalconeTSDBHeadSeriesOverBudget
      expr: {{ printf "prometheus_tsdb_head_series > %v" (dig "headSeriesBudget" 250000 $alerts) | quote }}
      for: 15m
      labels: {severity: warning}
      annotations:
        summary: Prometheus head series exceed the configured budget
    - alert: FalconeScrapeSampleLimitHit
      expr: 'increase(prometheus_target_scrapes_exceeded_sample_limit_total[15m]) > 0'
      for: 0m
      labels: {severity: warning}
      annotations:
        summary: A scrape exceeded observability.scrapeLimits.sampleLimit and was rejected
    - alert: FalconeRuleEvaluationFailures
      expr: 'increase(prometheus_rule_evaluation_failures_total[10m]) > 0'
      for: 0m
      labels: {severity: warning}
      annotations:
        summary: Prometheus rule evaluation is failing
    - alert: FalconePrometheusConfigReloadFailed
      expr: 'prometheus_config_last_reload_successful == 0'
      for: 5m
      labels: {severity: warning}
      annotations:
        summary: Prometheus failed to reload its configuration
    - alert: FalconeSecretBackendAuthDegraded
      expr: 'max by (component) (falcone_secret_backend_auth_degraded) == 1'
      for: 5m
      labels: {severity: critical}
      annotations:
        summary: Control-plane secret-backend authentication is degraded
    - alert: FalconeSecretBackendAuthFailing
      expr: {{ printf "max by (component) (falcone_secret_backend_auth_consecutive_failures) >= %v" (dig "secretAuthFailureThreshold" 3 $alerts) | quote }}
      for: 0m
      labels: {severity: warning}
      annotations:
        summary: Control-plane secret-backend authentication is failing repeatedly
{{- end -}}
