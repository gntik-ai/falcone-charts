{{- define "in-falcone.flowAuditRules" -}}
{{- $audit := .Values.flowAudit | default dict -}}
{{- $alerts := get $audit "alerts" | default dict -}}
- name: flow-audit
  rules:
    - alert: FalconeFlowAuditBacklog
      expr: {{ printf "falcone_flow_audit_outbox_rows{state=\"pending\"} > %v" (get $alerts "pendingRows" | default 100) | quote }}
      for: 10m
      labels: {severity: warning}
      annotations:
        summary: Flow audit outbox backlog is growing
    - alert: FalconeFlowAuditFailed
      expr: 'falcone_flow_audit_outbox_rows{state="failed"} > 0'
      for: 5m
      labels: {severity: critical}
      annotations:
        summary: Flow audit outbox has exhausted deliveries
    - alert: FalconeFlowAuditRelayStale
      expr: {{ printf "time() - falcone_flow_audit_relay_last_success_timestamp_seconds > %v or absent(falcone_flow_audit_relay_last_success_timestamp_seconds)" (get $alerts "relayStaleSeconds" | default 300) | quote }}
      for: 5m
      labels: {severity: warning}
      annotations:
        summary: Flow audit relay has not completed a successful tick
{{- end -}}
