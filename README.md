# classroom-advisor

A personal tool for a parent of young kids in remote school on Google Classroom. It watches the kids' accounts and raises an alarm when:

- **turned-in work doesn't match the assignment**: wrong, unfinished, missing or partial attachments, or a template turned in unchanged. The point is to catch this while the material is still fresh, not weeks later when (or if) the teacher checks.
- **work is left untouched** for more than a day after it was posted. Lesson-schedule posts that only carry a call invite and no homework are recognized (by the LLM, cached per post shape) and stay silent.
- **a deadline is close** (under 24h) and the work isn't turned in, or the work is marked missing.

Status: early PoC. See the [issues](https://github.com/lifecoderua/classroom-advisor/issues) and their milestones.

## How it works (short)

There is no Classroom API (the school domain blocks it, and Apps Script too). Instead, a **dedicated Chrome profile** stays logged in to the kids' accounts. We log in by hand **once**; the tool never automates logins. A collector drives that profile with Playwright over CDP and reads Classroom's own network responses. The data goes into SQLite, which is diffed so each assignment is cached and only re-checked when it changes. It's then checked by heuristics plus an LLM second pass (`claude -p` by default, Gemini optional). Alerts go to the console and, when configured, to a Telegram bot (panics at once, the rest in a daily digest).

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/CLASSROOM-INTERNALS.md](docs/CLASSROOM-INTERNALS.md) · [docs/DEPLOY.md](docs/DEPLOY.md) (Docker, microVM)

## Setup

0. Node 26 via nvm: `nvm install` in the project folder (reads `.nvmrc`), then `nvm alias default 26` so agent and non-interactive shells get it too. Don't keep a second Node (e.g. Homebrew's) ahead of nvm on `PATH`: better-sqlite3 is built for one Node ABI, and the CLI refuses to start on another major. After switching Node, run `pnpm rebuild better-sqlite3`: `pnpm install` alone doesn't rebuild it.
1. Create the collector's Chrome profile and log in to every kid account inside it (use Google's account switcher; the accounts can share one profile):
   ```bash
   open -na "Google Chrome" --args --user-data-dir="$HOME/.classroom-advisor/chrome-profile"
   ```
   Open classroom.google.com once for each account, then **quit that Chrome** (Cmd+Q). The collector can't use the profile while Chrome has it open.
2. Install the `claude` CLI and log in, if you want the default LLM provider.
3. `pnpm i`, then `pnpm db:migrate`, then `pnpm cli doctor`. Commands are documented in the CLI's `--help` as they land.
4. `pnpm cli accounts watch <email>` for each kid, then `pnpm cli sync`. The first sync per account is a baseline: it stores everything and only raises alerts for work that is missing or due within 24h. After that, `pnpm cli run` keeps syncing and checking every hour.
5. Optional, Telegram: create a bot with @BotFather, put its token in `.env` as `TELEGRAM_BOT_TOKEN`, send `/start` to the bot from your Telegram, then `pnpm cli telegram link` (saves your chat id to `config.local.json`; `--chat <id>` when several chats wrote to it) and `pnpm cli telegram test`. While `run` is going, the bot answers `/status`, `/digest`, `/refresh` (sync and check now, then a fresh digest in that chat), `/recheck <number or Classroom link>` (download the work again and re-check it; also tappable as `/recheck_<number>` under digest lines) and `/ack <id>` in linked chats only (a private chat or a group the bot was added to). Texts are in Ukrainian by default (`CA_DIGEST_LANG=uk|ru|en`) and times in `CA_TIMEZONE` (default `Europe/Kyiv`). Every digest (and `report`) repeats the open debts (teacher redo requests, missing work, "check by hand" items) until they're done, for up to `CA_BACKLOG_FORGET_DAYS` (14) days. The same number is the digest depth: an assignment due (or, without a due date, posted) longer ago than that doesn't get into the digest, the Telegram views, `/status` or `report` at all, and gets no new urgent alerts, even when it only shows up now or gets a new teacher comment. `/ack` on a missing or redo alert only mutes the alert; the debt stays until the work is turned in. Acking a "check by hand" item drops it.

## Privacy

The kids' data (captures, downloaded files, the DB) lives only under `.data/`, which is gitignored. Never commit real names, emails, IDs or content. Test fixtures are synthetic. Turned-in work is sent to the configured LLM provider.
