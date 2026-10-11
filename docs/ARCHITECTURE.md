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
| `store/` | Prisma 7 client (better-sqlite3 adapter, DB at `<dataDir>/app.db`) + repositories; JSON stored as strings |
| `sync/` | orchestration: diff, versioning, domain events |
| `checks/` | deadline rules, turned-in heuristics, LLM quality pass, verdict merge |
| `llm/` | `LlmProvider` adapter: `claude-cli` (default), `gemini`, `fake` |
| `notify/` | console digest; Telegram |
| `run/` | `run` loop: cycle orchestration, quiet hours, lock file |
| `cli/` | `doctor`, `accounts`, `recon`, `sync`, `check`, `report`, `run` |

## Accounts

One Chrome profile holds several Google accounts. We list them from the session (`accounts.google.com/ListAccounts` or the account switcher) and address each one with `?authuser=<email>`, which is stable, unlike `/u/N/`, which depends on login order. The **watch list** (which accounts to sync) lives in `config.local.json` (`accounts watch|unwatch <email>`) and is mirrored to `Account.watched` by those commands (when the DB exists) and at the start of every sync.

Session details (`src/collector/session.ts`, `accounts.ts`):
- Playwright `launchPersistentContext(profileDir, { channel })`, headful by default. `channel` is `chromeChannel` / `CA_CHROME_CHANNEL`: `chrome` (default, installed Google Chrome) or `chromium` (Playwright's bundled build, used by the Docker image on arm64). We drop Playwright's `--use-mock-keychain` / `--password-store=basic` defaults: with them Chrome can't decrypt the profile's cookies (macOS Keychain key) and the hand-made login looks gone.
- A live `SingletonLock` (`<host>-<pid>` symlink) in the profile means Chrome is open on it → `ProfileLockedError`.
- Discovery: **POST** `ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard` via `context.request` (shares the profile cookies; GET answers 400), parsed like Chromium does (`[3]` email, `[7]` authuser index, `[14]` signed out); fallback is reading emails off the account chooser page. No accounts → `SessionMissingError` (log in by hand).

## Data sources (see CLASSROOM-INTERNALS.md)

- Pages carry **no data in their HTML**. Everything loads through read-only internal RPCs (`/u/<n>/_/ClassroomUi/data/batchexecute`). Per account we open one Classroom page headless, read the tokens (`WIZ_global_data`), and then **call the RPCs directly** with same-origin `fetch`. This was tested on real data: 170 submissions came back in one call.
- To-do listing: `pONvgf` (paged) + `Zj93ge` (submissions, bucket `[20]`) + `gXtzob` (courses). Details: `tQShAc`, `t51ITc` (materials), `Zj93ge` with the attachments mask, `sLc6hf` (comments). See CLASSROOM-INTERNALS.md for positions.
- Code: `src/collector/classroom/` — `rpc.ts` (batchexecute client, allow-list, Playwright transport, request templates), `todo.ts` (`listTodo` → `AssignmentSummary[]`), `detail.ts` (`AssignmentDetail`), `enums.ts`, `parse-util.ts` (positional accessors + `ParseDriftError`).
- The rpcids are **allow-listed in code** (read-only only). `recon` stays as a fallback and as a way to diagnose drift.
- Files are read through the same session: Docs/Slides via `export?format=txt`, Sheets as csv, PDFs and images raw. They're cached by `driveFileId + modifiedAt`.
- File fetcher (`src/collector/files.ts`): `HttpGet` over `context.request` (+ `authuser=`). Docs `document/d/<id>/export?format=txt`, Slides `presentation/d/<id>/export/txt`, Sheets `export?format=csv`, everything else `drive.google.com/uc?export=download&id=<id>` (follows the large-file confirm form). PDFs: raw + text via `unpdf`; `contentPath` points at the `.txt`. Images stay as files. Forms, links, YouTube and videos: metadata only. Google-native files are recognized by Classroom's internal mimes too (`kix` doc, `punch` slides, `ritz` sheet, `freebird` form). Cache `<dataDir>/files/<driveFileId>/<modifiedAt|nomod>.<ext>` (one dir per file, so the LLM gets Read access to just that dir); `nomod` is always refetched. `contentHash` = sha256 of the `contentPath` file. A login redirect/page throws `SessionExpiredError`; other failures (HTTP, HTML instead of file, >25MB, timeout) return `{ ok: false, error }`.

We parse **network responses / embedded init data, not the DOM** (Classroom's CSS classes are generated). The parsers are defensive, and an empty or invalid parse raises `ParseDriftError`, which surfaces as an alert. Silent breakage is the main risk.

## Sync and caching

`src/sync/` (`pnpm cli sync [--account n] [--headful]`, and the first step of every `run` cycle). It opens the profile once (headless by default), mirrors the config watch list to `Account.watched`, discovers the logged-in accounts and, per watched account, opens one Classroom page and runs `syncAccount` over its RPC transport:
1. `listTodo` → summaries plus the full parsed `pONvgf` items (they already carry the instructions and material refs, so no `tQShAc` call is needed). Each summary gets a `summaryHash` (stored on `Assignment`).
2. `pickItems` chooses whose details to fetch: new items, a changed summary hash, open items due within 48h, and a slow full refresh (items not fetched for `fullRefreshDays`, default 7; at most 20 per sync, stalest first). The rest only get `lastSeenAt`.
3. Details (`fetchDetails`): `Zj93ge` with the list mask and the attachments mask, in batches of 100, plus `t51ITc` per item with material refs → `parseAssignmentDetail`. One item failing (drift, RPC error) is counted and skipped (its summary hash isn't stored, so it is retried); a `ParseDriftError` also raises `sync:<accountId>:drift:<rpcid>:<day>`.
4. Store (`applyDetail`): `upsertAssignment` with the normalized payload (`src/sync/normalize.ts`: `instructions`, `dueAt`, `maxPoints`, materials…; `updatedAt` is left out so it doesn't create versions). `status` comes from the To-do bucket (`assigned`, `missing`, `turned_in` incl. done late, `returned` incl. graded, `excused`) and is refreshed even when the hash is unchanged. Materials and the student's files (teacher-annotated copies excluded) go through `syncAttachments` with `isTemplate` / `templateSourceId`. `upsertSubmission` writes a `SubmissionVersion` on a hash change.
5. Events (`Event`, unique `key` → idempotent): `assignment.new:<assignmentId>`, `assignment.updated:<assignmentVersionId>` (payload `{changes: {field: {from, to}}}` over kind/title/instructions/dueAt/maxPoints/materials), and per new submission version `submission.turned_in|returned|unsubmitted:<versionId>` (state transitions; unsubmitted = turned in/returned → reclaimed) and `assignment.missing:<versionId>` (bucket became missing). `comment.new:<commentId>` comes from step 6.
6. Private comments (`src/sync/comments.ts`): `sLc6hf` for every listed non-material item with a submission, 100 submission keys per call (2 calls per account on the real data; a batch whose answer says `hasMore` is split in half and re-fetched). They're swept every sync because a new comment doesn't reliably change the submission's update time (see CLASSROOM-INTERNALS.md). Stored in `Comment` (deduped by `(assignmentId, classroomId)`; an edit updates `text` in place, no new event) with `authorRole` teacher/student, `authorId` and `postedAt`. A comment is **fresh** unless it's stored by the baseline sync, or it's on a baseline item and was posted before `Account.baselineAt`; non-fresh ones are stored with `baseline` set and nothing else. A fresh comment emits `comment.new:<commentId>` (payload `{authorRole, postedAt}`), and a fresh teacher comment raises `comment:<commentId>` (`alert`, message `Teacher comment on "<title>" (<course>): <text, ≤600 chars>`). Comments of items not stored yet (their details failed) are skipped and picked up next sync. A failed call is counted (`stats.comments.errors`); drift raises the usual `sync:<accountId>:drift:sLc6hf:<day>`.
7. Files: for post-baseline items whose submission is turned in or returned, attachments of that assignment (student work and materials) without cached content are fetched with `fetchAttachmentContents`. Videos, links, YouTube and Forms are metadata only.
8. Run log: one `SyncRun` row per account and sync (`ok | session_expired | session_missing | error`, `baseline`, counts as JSON). A `SessionExpiredError` (or an account that isn't logged in) stops that account, raises `sync:<accountId>:session_expired|session_missing:<day>` and never tries to log in. Other accounts still sync. The CLI prints one line of counts per account (no titles, names or emails).

**Baseline (alert-flood guard).** The first successful sync of an account (`Account.baselineAt` is null) is the baseline: everything is stored with `Assignment.baseline` / `SubmissionVersion.baseline` / `Comment.baseline` set, no events are emitted, no files are downloaded, and `baselineAt` is set at the end. Baseline items get only the panics (`missing`, `due_soon`), never `untouched_24h` / `no_due_date`, and baseline submission versions are never quality-reviewed (`pendingQualityVersions` skips them). Independently, `untouched_24h` and `no_due_date` apply only to items posted within `alertLookbackDays` (default 14). On the real data (2 accounts, ~350 items) the guard turns ~290 first-run alerts into 3 panics.

Runs are idempotent: running twice gives no duplicate versions, events or alerts.

## Checks

**Deadline rules** (pure, timezone-safe, UTC in storage):
- *alert*: posted more than 24h ago, not turned in, and no sign of work (no student attachment or doc edit).
- *panic*: due in under 24h and not turned in, **or** marked missing.
- No due date → weekly reminder. Material-only posts are ignored.
- Implemented in `src/checks/deadlines.ts` (pure, over a plain `DeadlineInput` snapshot) and `src/checks/evaluate-deadlines.ts` (loads watched, open assignments and calls `raiseAlert`). Excused items never alert. Baseline items get only the panics, and `untouched_24h` / `no_due_date` need the item to be posted within `lookbackMs` (`alertLookbackDays`, see Sync). Codes: `untouched_24h` (alert), `due_soon` / `missing` (panic; overdue counts as missing), `no_due_date` (info, after 7 days). Dedupe key `deadline:<assignmentId>:<code>`, plus `:<ISO week>` for `no_due_date` so it re-fires weekly. A panic suppresses `untouched_24h` in the same run. Boundaries are strict: exactly 24h is not yet late.

**Turned-in quality**, where the core problems are wrong or unchecked work and missing or partial attachments:
1. Heuristics produce *signals* with confidence, not verdicts: `no_attachments`, `fewer_attachments_than_expected`, `template_unchanged`, `empty_or_tiny_doc`, `fetch_failed`, `kind_hint` (quiz/online test/link).
   Zero attachments is often valid (a lesson with no homework, or an online test scored elsewhere), so signals alone rarely escalate. Only clear-cut cases do, such as a 100% unchanged template.
   Implemented in `src/checks/heuristics.ts` (pure `turnedInSignals(TurnedInInput)` → `{signals, directVerdict?}`, signals shaped like `ReviewInput.signals`) and `src/checks/evaluate-heuristics.ts` (loads one `SubmissionVersion`: current attachments, kind from mime, instructions from the latest assignment payload's `instructions`/`description`, text via an injected reader; `cachedTextReader(dataDir)` reads cached `.txt/.csv/.md` exports). Details:
   - `no_attachments`: base 0.5; up for upload words (uk/en stems: `прикріп`, `надішл`, `фото`, `виконай`, `зошит`, `attach`, `submit`, `photo`…) or a template; down for quiz/online test, link-only materials, `question` posts, empty posts.
   - `fewer_attachments_than_expected`: fewer than templates (0.6) or than parts in the instructions ("3 фото", "2 pages", numbered list; 0.3, since several parts often fit in one file).
   - `template_unchanged`: word 3-shingle Jaccard ≥ 0.98 against any material text (0.8; ≥ 0.999 → 0.99). Direct `panic` only when every attachment is an identical copy of a template with ≥ 5 words.
   - `empty_or_tiny_doc`: fewer than 15 own words (template words subtracted as a multiset), or a 0-byte file.
   - `fetch_failed`: a Google Doc/Slides/Sheet without text (PDFs/images may legitimately lack text).
   - `kind_hint`: `material` (short-circuits), `quiz` (quiz kind or Form material), `online_test` (keywords: `тест`, `онлайн`, `naurok`, `vseosvita`, `kahoot`…), `link_only`.
2. An LLM second pass gets the instructions, materials, student work (text + images) and the signals, and returns `{verdict ok|warn|panic, addressesAssignment, missingParts[], issues[], summaryForParent, confidence}`. The audience is young kids. Feedback is written in the assignment's language.
3. Merge → `CheckResult` → `Alert` (dedupe key `quality:<submissionVersionId>`).
   Implemented in `src/checks/quality.ts` with the versioned prompt `src/checks/prompts/review.v2.md` (`REVIEW_PROMPT_VERSION`, stored as `findings.promptVersion`):
   - `buildReviewInput` (pure): text budget of 24k chars (instructions ≤ 4k; 60% of the rest to the student's work, then materials, water-filled so short texts stay whole, truncation marked), student image paths, signals, `locale` (`uk` for Cyrillic, `en` for Latin), and `comments`: the latest 10 private comments (`REVIEW_COMMENTS`, oldest first, `{author, postedAt, text}`) within their own 4k-char budget. The prompt treats a teacher's redo/attach request that the work doesn't address as at least `warn`. A new comment doesn't trigger a re-review by itself (reviews are per submission version).
   - `mergeVerdict`: a heuristic direct panic wins; an LLM panic with confidence < 0.5 becomes warn; a provider failure falls back to the heuristics-only verdict for the merge result (`heuristicVerdict`: direct verdict, else warn on a problem signal with confidence ≥ 0.6).
   - `reviewSubmission(db, versionId, provider, readText, now, {imagePathOf})`: loads via `loadTurnedInInput` (now also course name, due date and cached image paths via `cachedImagePath`), stores a `heuristic` CheckResult (once) and an `llm:<provider>` one (verdict = merged verdict, findings `{promptVersion, output, merge}`), and raises the alert for warn (`alert`) / panic (`panic`) with the parent summary. Skips when this provider's result exists. On provider failure it stores no LLM result (the next run retries) and raises nothing, except a heuristics-only `quality:<id>` panic (marked as such) when the heuristics have a direct panic. Failures are counted per provider in the `heuristic` result's `findings.llmFailures`; at 3 it raises `quality:<id>:llm-failed` (`alert`: the automatic review couldn't run).
   - CLI: `check quality [--submission-version <id>] [--provider <name>]` runs it over `pendingQualityVersions` (latest turned-in/returned, non-baseline version per submission of watched accounts without a result from that provider). The `run` cycle reviews the same set right after sync.
   - Opt-in live prompt check: `CA_LLM_IT=1 pnpm test quality.integration` (synthetic Ukrainian homework, `CA_LLM_IT_VERBOSE=1` prints the outputs).

Later, a thin **user-rules** layer can adjust signals and verdicts, e.g. "online tests with no attachments are OK".

## LLM adapter

`LlmProvider { name; review(input): Promise<ReviewOutput> }`, with output validated by zod.
- `claude-cli` (`src/llm/claude-cli.ts`): `claude -p --output-format json --json-schema <ReviewOutput draft-07 schema> --no-session-persistence --strict-mcp-config [--model <claudeModel>]`, plus `--tools ""` (no tools) or, when attachments have an `imagePath`, `--tools Read --allowedTools Read --add-dir <image dirs>` so the model can view the images by path. Prompt on stdin, run from an empty temp cwd. Reads `structured_output` from the envelope (falls back to JSON inside `result`, code fences tolerated), zod-validates, retries once with a corrective prompt on invalid output, times out after `llmTimeoutMs` (default 180s), and surfaces stderr on failure.
  The caller passes the domain prompt as `review(input, { instructions })` (#20); `src/llm/prompt.ts` only wraps it with the input JSON, image paths and the output format.
  Only images are passed as files; other attachments must arrive as extracted `text`. Opt-in live test: `CA_LLM_IT=1 pnpm test llm.integration` (defaults to `--model haiku`).
- `gemini` (`src/llm/gemini.ts`): official `@google/genai` SDK, `models.generateContent` with `responseMimeType: application/json` + `responseJsonSchema` (the ReviewOutput schema minus `$schema`). Key from `GEMINI_API_KEY` (env or `.env` only; `config.local.json` rejects it), model from `geminiModel` / `CA_GEMINI_MODEL` (default `gemini-3.8-flash`, the latest stable Flash on the free tier as of 2026-10). Images (png/jpeg/webp/heic/heif) go inline as base64; the prompt lists their paths in order. 408/429/5xx and network errors retry with full-jitter exponential backoff (4 retries, 2s base, 60s cap, at least the server's `RetryInfo.retryDelay`); SDK retries stay off. Same corrective retry and zod validation as `claude-cli`; `llmTimeoutMs` bounds each HTTP attempt. `doctor` reports whether the key is set, never its value.
  Both providers run one shared contract test (`test/llm.contract.test.ts`) through their injected transports (command runner / SDK `fetch`). The live test runs Gemini only with `CA_LLM_IT=1` and `GEMINI_API_KEY`.
- `fake`: for tests.

## Alerts and notifications

`Alert {key, level info|alert|panic, message, sentAt}`. The console digest comes first (`report`). Then Telegram: panics are sent immediately, everything else in a daily digest; `/status`, `/digest`, `/ack`.

Console digest (`src/notify/console.ts`, `report [--since 24h] [--all]`): one section per watched account (DB `watched` or in the config watch list), labelled by display name or the email's local part. Sections: 🔴 panics, 🟠 alerts, 📥 work turned in within the window with the merged verdict (latest `llm:*` CheckResult with its `summaryForParent`, else the heuristic verdict marked "heuristics only", else "not reviewed yet"), 📅 open work due in the next 7 days (not turned in by status or submission state, materials excluded), ℹ️ info. Alerts are resolved to an account through their key (`deadline:<assignmentId>…`, `quality:<submissionVersionId>…`, `comment:<commentId>`, `sync:<accountId>…`); anything else lands in "Other". The default window shows alerts created since `--since` plus every unsent one; `--all` shows everything. The console never writes `sentAt`: that belongs to the Telegram notifier.

## Deployment

Phase 1: this laptop, `run` loop (default every 60 minutes, quiet hours).

`run [--once]` (`src/run/`): every `runIntervalMin` minutes (default 60) a cycle runs sync → `evaluateDeadlines` → `reviewSubmission` over `pendingQualityVersions` → prints a digest of the alerts raised in that cycle (alert id above the pre-cycle max). A failing step is logged and the next steps still run. Sync is an injected `SyncFn`; the CLI passes `playwrightSync(config)` (headless) and the deadline lookback. `quietHours` (`HH:MM-HH:MM`, local time, may cross midnight, end exclusive) skips cycles; `--once` runs one cycle regardless. `<dataDir>/run.lock` holds `{pid, host, startedAt}` and is created exclusively; a lock whose PID is dead on this host (or unreadable) is stale and replaced. SIGINT/SIGTERM stops after the current step (no new reviews start); a second Ctrl-C exits at once. A lock with our own PID on this host is stale too (a restarted container often reuses the PID).

Phase 2: Docker (Playwright base image, `/profile` and `/data` volumes, `prisma migrate deploy` on start, non-root) on a microVM, with a noVNC `login` command for the hand login. The session must be created on Linux itself (a macOS profile can't be decrypted there). Risk: Google may re-verify a session that comes from a cloud IP. See [DEPLOY.md](DEPLOY.md).
