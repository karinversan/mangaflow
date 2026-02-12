# Security Baseline

## Implemented in MVP
- Strict CORS allowlist.
- Upload content-type validation and payload size limit.
- Security headers in frontend:
  - CSP
  - X-Frame-Options
  - X-Content-Type-Options
  - Referrer-Policy
  - Permissions-Policy
- No secrets in repository (`.env.example` only).

## Required before production
- AuthN/AuthZ (OIDC/JWT + RBAC).
- Rate limiting on API (Redis backed).
- Malware scanning for uploads.
- Signed URLs for object storage.
- Audit log for edits and exports.
- WAF + reverse proxy TLS termination.
- Dependency scanning (SCA) + container image scanning.

## Data protection
- Encrypt data at rest (DB and object store).
- TLS in transit for every component.
- PII minimization and retention policy.
