# Contributing

Thank you for helping improve CohortHarbor. Contributions should keep the project self-hostable, privacy-conscious and compatible with the existing `SUPER_ADMIN`, `ADMIN` and `EMPLOYEE` permission model.

## Issues

Before opening an issue, search existing reports and check the current documentation. Include:

- a short problem statement and expected behavior;
- reproducible steps using synthetic data only;
- the command, browser and Node/pnpm versions involved;
- a minimal error message or redacted log excerpt;
- screenshots only after removing names, email addresses, employee numbers and private document content.

Never paste `.env` values, database files, SMTP output, access tokens or real employee records into an issue. For a suspected security vulnerability, do not disclose exploit details publicly; follow [`SECURITY.md`](../SECURITY.md).

## Code contributions

1. Fork or clone the repository and create a focused branch from the current release branch.
2. Read the relevant architecture and security documentation.
3. Keep business logic changes separate from formatting-only changes.
4. Add or update unit/integration tests for service and API behavior; add an E2E test when the change crosses a browser flow.
5. Use mock organization, mock employee and `example.invalid` addresses in fixtures.
6. Run the relevant checks locally:

   ```bash
   corepack prepare pnpm@11.16.0 --activate
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm licenses:generate
   pnpm sbom:generate
   ```

7. Review `git diff` and `git status` to ensure private files, generated output and local environment files are not included.

## Pull Requests

PRs should explain the user-visible outcome, affected routes/services, migration impact and verification commands. Keep the PR small enough to review, link the issue when applicable, and call out any security or backward-compatibility implications.

Maintainers may request changes if a PR weakens server-side authorization, exposes private storage, adds real-looking business data, fabricates AI behavior, omits required third-party attribution, or lacks tests for a changed contract. A PR is ready to merge only after required checks pass and the review comments are resolved.
