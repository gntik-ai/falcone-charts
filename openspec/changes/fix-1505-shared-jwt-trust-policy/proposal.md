# Shared JWT deployment configuration

Console tokens issued through the in-cluster Keycloak URL can fail executor
verification while passing control-plane verification. Both Deployments must
consume one explicit issuer and audience policy from the existing
`executor-jwt-config` ConfigMap.

This deployment portion of falcone #1505 also provisions and reconciles the
platform console audience mapper. It preserves the deterministic Helm adapter,
External Secrets/OpenBao boundaries, TLS trust and migration gates. Source
verification, image promotion and operator staging checks are separate work.
