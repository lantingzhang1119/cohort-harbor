# Security Design

This document describes the protections implemented in the application and the limits that operators must understand. It is not a claim that a deployment is secure without configuration, patching and operational controls.

## RBAC and session authorization

The application preserves three roles: `SUPER_ADMIN`, `ADMIN` and `EMPLOYEE`.

- `requireSession` rejects missing, expired, revoked or password-change-required sessions.
- Admin routes require both admin view mode and `ADMIN` or `SUPER_ADMIN`.
- Administrator lifecycle and other super-admin-only actions require `SUPER_ADMIN`.
- Employee APIs and views are tied to the authenticated account; ownership checks prevent cross-account access.
- Employee module switches are enforced by server-side routes and file endpoints, not only by navigation visibility.

Role checks should remain on the server when adding a new route. A UI control that is hidden or disabled is not an authorization mechanism.

## Private storage and file access

Uploaded policy files, previews, onboarding materials, mail assets and portal assets are stored below `PRIVATE_STORAGE_ROOT`. The storage helpers:

- reject absolute paths and path traversal;
- resolve symlinks before serving existing files;
- keep the candidate below the configured private root;
- validate extension, MIME type and file structure for supported uploads;
- stream authorized files with `private`, `no-store` and `nosniff` response headers.

The database stores asset metadata and ownership/publication state. The `public/` directory is for intentionally public static assets only. Operators must also protect the private directory and database with filesystem permissions and backup ACLs.

## Watermark mechanism

Policy, guide and examination views can render a repeated watermark containing the current signed-in display name and the application brand. Opacity is bounded by the UI component and can be supplied by system settings. Watermarks help with accountability and discourage casual redistribution; they do not prevent screenshots, screen recording or a privileged filesystem reader from copying content.

## Credentials and mail

- Passwords are stored as salted hashes; plaintext passwords should never be committed or logged.
- Password reset tokens are stored as digests and are time-limited and single-use.
- SMTP is disabled unless the required configuration is present and the relevant business/runtime switches are enabled.
- Mail operations use confirmation, idempotency, leases and bounded retries. Unknown delivery outcomes require operator verification before retrying.
- Do not send real mail from a development environment or use real recipient addresses in automated tests.

## Data isolation

Published versions, city applicability, employee module settings, account role and resource ownership jointly determine what a user can see. Drafts and orphaned private assets are not employee-readable through normal routes. Use separate databases and private roots for separate organizations when a deployment requires hard tenant isolation; the current schema is organization-oriented but does not claim a complete multi-tenant control plane.

## Open-source hygiene

- Keep `.env` and runtime files ignored.
- Keep real employee exports, policy originals, mail attachments, databases and backups out of commits.
- Use `example.invalid` for synthetic email addresses.
- Review new fixtures and screenshots for names, employee numbers, URLs, tokens and document contents.
- Treat the public Git history as sensitive: removing a file from the latest tree does not remove it from old commits.
- Keep `THIRD_PARTY_NOTICES.md` and `sbom.spdx.json` synchronized with the lockfile after dependency changes.
- Treat all fixed credentials under `tests/` and `e2e/` as synthetic fixtures only; never reuse them in a deployment.

Privately report suspected vulnerabilities using the process in [`SECURITY.md`](../SECURITY.md). Do not open a public issue containing exploit details, credentials, employee data or private documents.

## Known limits

This release uses SQLite and local filesystem storage by default. An administrator or process with host-level read access can read those files. Production deployments should add OS isolation, encrypted backups, monitoring, rate limiting and a documented retention policy. AI retrieval, if added later, must apply the same access checks before indexing and before generating an answer.
