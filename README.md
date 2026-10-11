# classroom-advisor

A personal tool for a parent of young kids in remote school on Google Classroom. It watches the kids' accounts and raises an alarm when:

- **turned-in work doesn't match the assignment**: wrong, unfinished, missing or partial attachments, or a template turned in unchanged. The point is to catch this while the material is still fresh, not weeks later when (or if) the teacher checks.
- **work is left untouched** for more than a day after it was posted.
- **a deadline is close** (under 24h) and the work isn't turned in, or the work is marked missing.

Status: early PoC. See the [issues](https://github.com/lifecoderua/classroom-advisor/issues) and their milestones.

## How it works (short)

There is no Classroom API (the school domain blocks it, and Apps Script too). Instead, a **dedicated Chrome profile** stays logged in to the kids' accounts. We log in by hand **once**; the tool never automates logins. A collector drives that profile with Playwright over CDP and reads Classroom's own network responses. The data goes into SQLite, which is diffed so each assignment is cached and only re-checked when it changes. It's then checked by heuristics plus an LLM second pass (`claude -p` by default, Gemini optional). Alerts go to the console now and Telegram next.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/CLASSROOM-INTERNALS.md](docs/CLASSROOM-INTERNALS.md) · [docs/DEPLOY.md](docs/DEPLOY.md) (Docker, microVM)

## Setup

1. Create the collector's Chrome profile and log in to every kid account inside it (use Google's account switcher; the accounts can share one profile):
   ```bash
   open -na "Google Chrome" --args --user-data-dir="$HOME/.classroom-advisor/chrome-profile"
   ```
   Open classroom.google.com once for each account, then **quit that Chrome** (Cmd+Q). The collector can't use the profile while Chrome has it open.
2. Install the `claude` CLI and log in, if you want the default LLM provider.
3. `pnpm i`, then `pnpm db:migrate`, then `pnpm cli doctor`. Commands are documented in the CLI's `--help` as they land.
4. `pnpm cli accounts watch <email>` for each kid, then `pnpm cli sync`. The first sync per account is a baseline: it stores everything and only raises alerts for work that is missing or due within 24h. After that, `pnpm cli run` keeps syncing and checking every hour.

## Privacy

The kids' data (captures, downloaded files, the DB) lives only under `.data/`, which is gitignored. Never commit real names, emails, IDs or content. Test fixtures are synthetic. Turned-in work is sent to the configured LLM provider.
