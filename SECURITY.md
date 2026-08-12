# Security Policy

## Supported versions

Security fixes are applied to the latest commit on `main`. Until the first tagged stable release, the `0.1.x` development line is the only supported line.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/lantingzhang1119/cohort-harbor/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include the affected route or component, prerequisites, impact, a minimal reproduction using synthetic data, and any suggested mitigation. Do not send live credentials, `.env` files, employee records, private documents, production database copies, SMTP transcripts, or access tokens.

Maintainers will acknowledge a report when it is reviewed, coordinate validation and remediation privately, and publish a security advisory when users need to take action. No response-time SLA is promised for this volunteer-maintained project.

## Scope notes

The default SQLite and local-filesystem deployment assumes the host administrator is trusted. Watermarks discourage casual redistribution but do not prevent screenshots. Deployment hardening, HTTPS, backups, secret management, monitoring, rate limits and data-retention controls remain the operator's responsibility.
