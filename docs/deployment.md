# Deployment

This guide describes a local or self-hosted deployment. Use organization-managed secrets and private storage for any real installation. The repository contains only synthetic seed content.

## Requirements

- Node.js `24.14.0` (the supported 24.x release pinned by CI).
- pnpm `11.16.0`, matching `package.json#packageManager`.
- A writable application directory for the SQLite database and private files.
- Optional: SMTP credentials for password reset or onboarding mail; LibreOffice, `pdftoppm` and Tesseract data for some document/OCR workflows.

## Install and configure

```bash
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env` and provide at least:

- `DATABASE_URL`: a local SQLite URL such as `file:./storage/private/demo.db`, or the connection value supported by the deployment.
- `ADMIN_USERNAME`: the first administrator identifier.
- `ADMIN_PASSWORD`: a private password with at least 10 characters, including letters and digits.
- `AUTH_TOKEN_SECRET`: an independent random secret of at least 32 characters, used for keyed password-reset token digests. Generate and store it in the deployment secret manager; do not derive it from `ADMIN_PASSWORD`.
- `ADMIN_DISPLAY_NAME`: the display name for the initial super administrator.
- `PRIVATE_STORAGE_ROOT`: a directory that is not served as a public static asset.

Keep SMTP variables empty unless mail is intentionally enabled. If mail is enabled, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `APP_BASE_URL`, and a unique `ONBOARDING_MAIL_CONFIRMATION_SECRET` through the deployment secret manager. Do not put these values in Git, screenshots or issue reports.

## Initialize the database

```bash
pnpm db:ensure
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

The seed is idempotent. It creates or verifies the configured super administrator, system settings, generic city guide entries, built-in mail fields and a public mock exam. `prisma/seed.example.ts` contains public descriptors for a mock organization and employee; it is a data-shape example, not a production import.

For an administrator-only initialization, use `pnpm admin:init` after setting the required variables. Never use a real employee export as a seed file.

## Run

Development:

```bash
pnpm dev
```

Production build:

```bash
pnpm build
pnpm start
```

The application listens on the Next.js default port unless the host or port is configured by the runtime. Place a reverse proxy and HTTPS termination in front of a production deployment, and restrict access to the private storage directory at the operating-system level.

## Optional document processing

Policy preview and question-bank import can use local tools. Configure paths such as `SOFFICE_PATH`, `PDFTOPPM_PATH`, `TESSDATA_PREFIX`, `FONTCONFIG_FILE` or `OFFICE_FONT_DIRECTORY` only when the corresponding tool is installed. These tools process files locally; they are not a substitute for validating uploaded content and access control.

## Production checklist

- Use a unique, rotated administrator password and mail confirmation secret.
- Keep `.env`, `storage/private/`, `uploads/`, `documents/` and `attachments/` outside public artifacts and backups shared with contributors.
- Use HTTPS, secure cookie settings and a reverse proxy with request-size limits.
- Back up the database and private files using an access-controlled backup system.
- Run migrations during a maintenance window and test restore procedures.
- Replace all mock organization, guide and exam content through an authorized import process.
- Review the [security design](security.md) before enabling SMTP automation.
