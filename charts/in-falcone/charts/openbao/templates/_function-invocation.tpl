{{/* This exact-path read policy is bound only to ESO, never platform-role. */}}
{{- define "openbao.policy.functionInvocation" -}}
path "secret/data/{{ (.Values.global.functionInvocation | default dict).remoteKey | default "control-plane/function-invocation" }}" {
  capabilities = ["read"]
}
{{- end -}}

{{/* Shared install/upgrade bootstrap. CAS=0 never replaces a retained signer. */}}
{{- define "openbao.functionInvocation.seed" -}}
set +x
umask 077
invocation_path={{ printf "secret/%s" ((.Values.global.functionInvocation | default dict).remoteKey | default "control-plane/function-invocation") | quote }}
invocation_dir=/function-invocation
# Bootstrap owns policy writes; the auth reconciler remains metadata-only.
# Embed package bytes so upgrades cannot consume a stale live ConfigMap.
cat > "$invocation_dir/policy.hcl" <<'FALCONE_FUNCTION_INVOCATION_POLICY'
{{ include "openbao.policy.functionInvocation" . }}
FALCONE_FUNCTION_INVOCATION_POLICY
bao policy write function-invocation "$invocation_dir/policy.hcl" >/dev/null 2>&1 || {
  echo "Function invocation signer policy provisioning failed" >&2; exit 1;
}
rm -f "$invocation_dir/policy.hcl"
invocation_complete() {
  for property in private-key key-id jwks; do
    bao kv get -field="$property" "$invocation_path" >/dev/null 2>&1 || return 1
  done
}
if bao kv get "$invocation_path" >/dev/null 2>&1; then
  touch "$invocation_dir/.skip"
  invocation_complete || { echo "Function invocation signer record is incomplete" >&2; exit 1; }
else
  touch "$invocation_dir/.generate"
  i=0
  until [ -f "$invocation_dir/.ready" ]; do
    [ ! -f "$invocation_dir/.failed" ] || { echo "Function invocation key generation failed" >&2; exit 1; }
    i=$((i+1)); [ "$i" -le 120 ] || { echo "Function invocation key generation timed out" >&2; exit 1; }
    sleep 1
  done
  # A racing installer or transient read error must never overwrite a key.
  if ! bao kv put -cas=0 "$invocation_path" \
    private-key=@"$invocation_dir/private-key" \
    key-id=@"$invocation_dir/key-id" \
    jwks=@"$invocation_dir/jwks" >/dev/null 2>&1; then
    invocation_complete || { echo "Function invocation signer provisioning failed" >&2; exit 1; }
  fi
  touch "$invocation_dir/.stored"
fi
echo "Function invocation signer converged"
{{- end -}}

{{- define "openbao.functionInvocation.generator" -}}
- name: function-invocation-key-generator
  # Reuse the chart's existing dedicated OpenSSL image, never tenant code.
  image: {{ include "openbao.image" (dict "root" . "image" .Values.openbao.tls.bootstrap.generatorImage) | quote }}
  imagePullPolicy: {{ .Values.openbao.tls.bootstrap.generatorImage.pullPolicy }}
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: ["ALL"]
  command: ["/bin/sh", "-ec"]
  args:
    - |
      set +x
      umask 077
      D=/function-invocation
      trap 'touch "$D/.failed"; rm -f "$D/private-key" "$D/public.der" "$D/key-id" "$D/jwks"' EXIT
      i=0
      until [ -f "$D/.generate" ]; do
        [ ! -f "$D/.skip" ] || { trap - EXIT; exit 0; }
        i=$((i+1)); [ "$i" -le 1500 ] || exit 1
        sleep 1
      done
      openssl genpkey -algorithm ED25519 -out "$D/private-key" 2>/dev/null
      openssl pkey -in "$D/private-key" -pubout -outform DER -out "$D/public.der" 2>/dev/null
      # RFC 8410 Ed25519 SPKI has a 12-byte prefix and a 32-byte public key.
      [ "$(wc -c < "$D/public.der" | tr -d ' ')" = 44 ]
      x=$(tail -c 32 "$D/public.der" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
      [ "${#x}" -eq 43 ]
      kid="fn-$(openssl dgst -sha256 -r "$D/public.der" | awk '{print $1}')"
      printf '%s' "$kid" > "$D/key-id"
      printf '{"keys":[{"kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","kid":"%s","x":"%s"}]}' "$kid" "$x" > "$D/jwks"
      touch "$D/.ready"
      i=0
      until [ -f "$D/.stored" ]; do
        i=$((i+1)); [ "$i" -le 120 ] || exit 1
        sleep 1
      done
      rm -f "$D/private-key" "$D/public.der" "$D/key-id" "$D/jwks"
      trap - EXIT
  volumeMounts:
    - name: function-invocation
      mountPath: /function-invocation
{{- end -}}
