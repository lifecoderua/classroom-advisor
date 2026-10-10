# Agent guide

Read `README.md`, `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` first.

## Workflow
- Work comes from GitHub issues. One issue → one branch named `<issue#>-<short-slug>` (e.g. `4-session-accounts`) → PR with `Closes #<n>` → squash-merge.
- Greenfield: breaking changes are fine. Don't add compatibility shims.
- Keep docs in sync. If you learn something durable (Classroom shapes, a decision), update `docs/`.

## Hard rules
- **No real kid data in git**: no names, emails, IDs, course names, captures, screenshots or file contents. Real data goes only under `.data/` (gitignored). Fixtures under `fixtures/` are synthetic or anonymized.
- **Read-only against Classroom.** Never click or trigger turn in, unsubmit, comments or any other state-changing action.
- **Never automate Google login** or handle passwords. If the session is missing, report it and stop.
- The collector profile is `~/.classroom-advisor/chrome-profile`. Chrome must not be running on it while the collector runs.

## Commands
- `pnpm check`: typecheck + lint
- `pnpm test`: vitest
- `pnpm cli <cmd>`: run the CLI via tsx
- `pnpm db:migrate`: Prisma migrate dev
