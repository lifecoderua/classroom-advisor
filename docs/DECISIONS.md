# Decisions

A short log of decisions. Newest at the bottom. Greenfield: breaking changes are fine and there's no backward compatibility.

### D1. No official API (2026-10)
Both the Classroom API (OAuth) and Apps Script under the kids' accounts were tested and are blocked by the school's domain policy. Access would need the domain admin, which is slow and wouldn't scale. **Revisit** if the admin grants it, since the API would replace most of the collector.

### D2. Never automate login
The kid accounts have passwords and no 2FA, but scripted logins trigger Google's challenges and are flaky. We reuse a **session that was logged in by hand**. When the session expires, the tool reports it and stops; a human logs in again.

### D3. Collector = dedicated Chrome profile + Playwright/CDP
Recent Chrome versions block automation on the default profile, so the collector uses its own `--user-data-dir` (`~/.classroom-advisor/chrome-profile`) with every kid account multi-logged-in. Accounts are selected with `authuser=<email>`.
Compared with a browser extension, this gives us control over scheduling, testability, and nothing for the kids to switch off. **Fallback:** an MV3 extension in a daily-use browser, reusing the same parsers (#16), if Google flags the automated profile.

### D4. Parse network data, not the DOM
Classroom's CSS is generated. RPC and init-data payloads are positional arrays, which is also fragile but changes less often. Parsers are isolated and tested on synthetic fixtures, and drift raises an alert.

### D5. SQLite + Prisma
Single user and small data. Prisma is used for its schema and migrations. Postgres only if we ever go multi-user.

### D6. Heuristics produce signals; the LLM decides
Zero attachments is often legitimate (lessons without homework, online tests). Heuristics feed signals into the LLM pass instead of panicking on their own. User-defined rules will come later.

### D7. LLM adapter: `claude -p` first, Gemini second
Use the local `claude` CLI (no API key to manage). Gemini by API key comes next because of its free tier. The provider can be swapped through config.

### D8. Privacy
Real data (captures, files, DB) stays only under gitignored `.data/`. Fixtures are synthetic. The repo is private. Personal use only for now. If this ever goes public, onboarding must explain the session reuse and that work is sent to an LLM.

### D9. Telegram right after the MVP
The MVP is data + minimal checks + console report. Telegram is the first notifier after that.

### D10. Call the internal read-only RPCs directly (2026-10-11)
Recon (#18) found that To-do and detail pages embed no data; it all arrives via `batchexecute` RPCs. Rendering pages and sniffing traffic works, but it's slow and fragile. So we open one page per account for the session tokens, then call the allow-listed read-only rpcids ourselves. The risk is an undocumented API whose positions and rpcids can change. That's why parsers sit behind `ParseDriftError`, fixtures are kept, and `recon` is there to re-learn the shapes.

### D11. First sync is a baseline; reminders have a lookback (2026-10-11)
The real To-do lists hold hundreds of old items, mostly lesson posts with no homework. Without a guard the first sync would raise ~290 `untouched_24h` / `no_due_date` alerts and send every old turned-in submission to the LLM. So the first successful sync per account only records a baseline (no events, no file downloads, no reviews, only the `missing` / `due_soon` panics for those items), and the two reminders apply only to items posted within `alertLookbackDays` (default 14). Items are flagged at creation, so a baseline interrupted by an expired session continues as a baseline next time.

### D12. Docker: log in inside the container, via noVNC (2026-10-11)
The image (#14) runs `run` with the Chrome profile and the data as volumes. A profile can't move from macOS to Linux: Chrome's cookie key lives in the macOS Keychain, while in the container Chrome uses its fixed "basic" key, so a copied profile looks logged out. So the image ships a `login` command (Xvfb + x11vnc + noVNC on loopback) where a human logs in by hand on the machine that will run the collector (D2 still holds). Google Chrome stable has no linux/arm64 build, so the browser is configurable (`CA_CHROME_CHANNEL=chromium` for Playwright's bundled build) and the image picks it automatically on arm64. The container defaults to Gemini (an API key in `.env`); `claude-cli` is an opt-in build arg plus `CLAUDE_CODE_OAUTH_TOKEN`.

### D13. Sweep private comments every sync; alert on fresh teacher comments (2026-10-11)
Teacher comments ("redo", "attach the photo") are high-signal, but a new comment doesn't reliably change the submission's update time, so fetching comments only for re-fetched items would miss some (5 of 24 commented submissions on the real data). `sLc6hf` accepts 100 submission keys per call, so every sync sweeps all of them for ~2 calls per account. Comments that predate the baseline (or arrive in it) are stored silently; every later teacher comment raises an `alert` with its text in the local digest. Student comments only emit `comment.new`.

### D14. Teacher comments re-queue a review; redo requests are panics (2026-10-11)
Reviews run once per submission version, but a teacher's "переробити" / "прикрепи фото" usually arrives after the review, often with no new version. So a fresh teacher comment re-queues one more review of the latest version (watermark `CheckResult.throughCommentId`, so one comment = at most one re-review), and that re-review alerts under its own key (`quality:<id>:c<commentId>`) only when the verdict got worse, so the parent doesn't get the same verdict twice. A keyword list (uk/ru/en word-start stems) rather than the LLM decides whether the comment alert is a `panic`: it fires at sync time, before any review, and needs no provider. False positives are cheap (one panic about a real teacher comment); the LLM verdict is floored at `warn` while the request is open. Baseline versions are still never reviewed (D11; their files aren't downloaded), so a redo comment on one only raises the comment alert.

### D15. `Alert.sentAt` means "delivered to Telegram"; the console stays read-only (2026-10-11)
There's one push channel, so delivery state is one column, not a per-channel table. Telegram owns `sentAt`: it sets it after a successful send (panics right after the cycle, the rest in the daily digest), and the console `report` and the `run` printout never write it, so they keep working the same with or without Telegram. Without Telegram nothing marks alerts sent and the console shows unsent ones as before. `/ack <id>` sets a separate `mutedAt` (plus `sentAt` if unset, so a muted alert never goes out); muted alerts drop out of digests, `/status` and the default console window. Telegram sends only alerts from the last 7 days, so enabling it on an old DB doesn't replay history. **Revisit** with a per-channel delivery table if a second push channel (email, etc.) appears.
