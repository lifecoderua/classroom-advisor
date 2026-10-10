# Architecture

```
┌──────────── collector (home machine; later a microVM) ───────────┐
│ Chrome (dedicated profile, kids multi-logged-in)                  │
│   ↑ Playwright / CDP                                              │
│ session → accounts → To-do lists → assignment details → files     │
└──────────────┬────────────────────────────────────────────────────┘
               │ normalized objects (zod)
┌──────────────▼──────────── core ──────────────────────────────────┐
│ sync: hash/diff → store (SQLite+Prisma, versioned) → domain events │
│ checks: deadline rules │ turned-in heuristics → LLM second pass    │
│ alerts (deduped) → notify: console now, Telegram next              │
└───────────────────────────────────────────────────────────────────┘
```

For now it's a single TS package with modules under `src/`:

| Module | Responsibility |
|---|---|
| `config/` | `.env` + `config.local.json` (watched accounts, profile dir, provider), zod-validated |
| `collector/` | browser session, account discovery, page/RPC capture, parsers, file fetcher |
| `store/` | Prisma client + repositories |
| `sync/` | orchestration: diff, versioning, domain events |
| `checks/` | deadline rules, turned-in heuristics, LLM quality pass, verdict merge |
| `llm/` | `LlmProvider` adapter: `claude-cli` (default), `gemini`, `fake` |
| `notify/` | console digest; Telegram |
| `cli/` | `doctor`, `accounts`, `recon`, `sync`, `check`, `report`, `run` |

## Accounts

One Chrome profile holds several Google accounts. We list them from the session (`accounts.google.com/ListAccounts` or the account switcher) and address each one with `?authuser=<email>`, which is stable, unlike `/u/N/`, which depends on login order. The **watch list** (which accounts to sync) lives in `config.local.json`.

## Data sources (see CLASSROOM-INTERNALS.md)

- Student To-do pages `/a/not-turned-in/all`, `/a/missing/all`, `/a/turned-in/all` cover all courses in a single listing.
- Assignment detail pages give the instructions, materials, submission state and the student's attachments.
- Files are read through the same session: Docs/Slides via `export?format=txt`, Sheets as csv, PDFs and images raw. They're cached by `driveFileId + modifiedAt`.

We parse **network responses / embedded init data, not the DOM** (Classroom's CSS classes are generated). The parsers are defensive, and an empty or invalid parse raises `ParseDriftError`, which surfaces as an alert. Silent breakage is the main risk.

## Sync and caching

1. List the To-do pages → summaries → content hash.
2. Fetch details only for items that are new or changed, plus open items due within 48h, plus a slow periodic full refresh.
3. On a hash change, write `AssignmentVersion` / `SubmissionVersion`. History is kept, e.g. for "teacher moved the deadline".
4. Emit events: `assignment.new|updated|missing`, `submission.turned_in|unsubmitted|returned`.

Runs are idempotent: running twice gives no duplicate events or alerts.

## Checks

**Deadline rules** (pure, timezone-safe, UTC in storage):
- *alert*: posted more than 24h ago, not turned in, and no sign of work (no student attachment or doc edit).
- *panic*: due in under 24h and not turned in, **or** marked missing.
- No due date → weekly reminder. Material-only posts are ignored.

**Turned-in quality**, where the core problems are wrong or unchecked work and missing or partial attachments:
1. Heuristics produce *signals* with confidence, not verdicts: `no_attachments`, `fewer_attachments_than_expected`, `template_unchanged`, `empty_or_tiny_doc`, `fetch_failed`, `kind_hint` (quiz/online test/link).
   Zero attachments is often valid (a lesson with no homework, or an online test scored elsewhere), so signals alone rarely escalate. Only clear-cut cases do, such as a 100% unchanged template.
2. An LLM second pass gets the instructions, materials, student work (text + images) and the signals, and returns `{verdict ok|warn|panic, addressesAssignment, missingParts[], issues[], summaryForParent, confidence}`. The audience is young kids. Feedback is written in the assignment's language.
3. Merge → `CheckResult` → `Alert` (dedupe key `quality:<submissionVersionId>`).

Later, a thin **user-rules** layer can adjust signals and verdicts, e.g. "online tests with no attachments are OK".

## LLM adapter

`LlmProvider { name; review(input): Promise<ReviewOutput> }`, with output validated by zod.
- `claude-cli`: `claude -p --output-format json`, prompt on stdin, with a timeout and retry on invalid JSON.
- `gemini`: `GEMINI_API_KEY`, a free-tier Flash model, JSON schema output, images inline.
- `fake`: for tests.

## Alerts and notifications

`Alert {key, level info|alert|panic, message, sentAt}`. The console digest comes first (`report`). Then Telegram: panics are sent immediately, everything else in a daily digest; `/status`, `/digest`, `/ack`.

## Deployment

Phase 1: this laptop, `run` loop (default every 60 minutes, quiet hours). Phase 2: Docker (Playwright base image, with the profile and `.data` as volumes) on a microVM. Risk: Google may re-verify a session that suddenly comes from a cloud IP. Plan for a noVNC re-login.
