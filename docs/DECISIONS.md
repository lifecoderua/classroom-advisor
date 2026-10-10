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
