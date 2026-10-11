# Deploy

Two phases: the laptop (native or Docker) first, then a small Linux microVM running the same
Docker image. The image runs the `run` loop; the Chrome profile and the data live in volumes.

## What's in the image

- `Dockerfile`: multi-stage, both stages on `mcr.microsoft.com/playwright:v<version>-noble` (the
  tag must match `playwright` in `pnpm-lock.yaml`; `test/docker.test.ts` checks it). The first
  stage runs `pnpm install --frozen-lockfile` (better-sqlite3, Prisma engines, generated client);
  the second adds Google Chrome stable (amd64 only), the noVNC login stack (Xvfb, x11vnc,
  websockify, noVNC) and `tini`, and runs as the non-root `pwuser` (uid 1000).
- Volumes: `/profile` (Chrome user-data-dir, `CA_PROFILE_DIR`) and `/data` (SQLite, cached files,
  `run.lock`; `CA_DATA_DIR`).
- `docker/entrypoint.sh`: `run` (default) and every other CLI command first run
  `prisma migrate deploy` on `/data/app.db`. `login` starts the hand-login session (below).
  `sh`, `bash`, `claude` and `node` run as is.
- Browser: `CA_CHROME_CHANNEL=chrome` when `/opt/google/chrome/chrome` exists, else `chromium`
  (Playwright's bundled build; Google ships no Chrome for linux/arm64). Set it explicitly to
  override. The profile must be logged in with the same browser the collector uses; `login` does
  that automatically.
- The build context excludes `.data`, `config.local.json`, `.env`, `captures` and `.claude`
  (`.dockerignore`), so no real data or secrets end up in the image.
- Default LLM provider in the container: `gemini` (`GEMINI_API_KEY` from `.env`).

## The profile can't be copied from macOS

Chrome encrypts cookies with a per-OS key: on macOS the key sits in the Keychain ("Chrome Safe
Storage"), on Linux it comes from the desktop keyring or, without one (as in the container), a
fixed "basic" key. A profile copied from the Mac to Linux can't decrypt its cookies and looks
logged out. The same goes for a profile from a Linux desktop that used GNOME Keyring/KWallet.

So the session has to be **created where it runs**: inside the container, on the machine that
will run the collector. A human logs in by hand through noVNC. The tool never types or stores a
password (D2).

## Phase 1: laptop

On the Mac the native setup in the README stays the primary way. Docker on the laptop is the
rehearsal for the VM.

```bash
cp .env.example .env    # set GEMINI_API_KEY and CA_WATCHED_ACCOUNTS=kid1@...,kid2@...
docker compose build    # Apple Silicon builds arm64 → bundled Chromium
docker compose run --rm -p 127.0.0.1:6080:6080 advisor login
```

Open <http://localhost:6080/vnc.html>, click Connect, log in to every kid account by hand (use
the account switcher), open classroom.google.com once per account, then quit Chrome from its
menu (Exit). The container stops and the profile stays in the `profile` volume. Then:

```bash
docker compose run --rm advisor doctor --session   # counts logged-in accounts
docker compose run --rm advisor sync               # first sync = baseline
docker compose up -d                               # run loop
docker compose logs -f advisor
```

Notes:
- **Stop the loop before logging in again** (`docker compose stop advisor`). Two Chromes on one
  profile corrupt it; Chrome's lock only protects same-host processes.
- The compose file pins `hostname: classroom-advisor`. Chrome's `SingletonLock` and `run.lock`
  record `<host>-<pid>`, and a lock from another host counts as held, so a random hostname per
  container would block the next start after a crash.
- **Watch list:** `accounts watch` writes `config.local.json`, which isn't in the image. In the
  container use `CA_WATCHED_ACCOUNTS` in `.env`, or bind-mount a `config.local.json` to
  `/app/config.local.json`.
- **Bind mounts** instead of the named volumes must be writable by uid 1000
  (`chown -R 1000:1000 <dir>`).
- `docker compose run --rm advisor report` prints the console digest from the same DB.

## LLM providers in the container

- **gemini** (default): set `GEMINI_API_KEY` in `.env`. Nothing else is needed.
- **claude-cli**: build with the CLI baked in and switch the provider:
  ```bash
  INSTALL_CLAUDE=1 docker compose build
  # .env: CA_LLM_PROVIDER=claude-cli
  ```
  The CLI needs its own login inside the container. The simplest is a long-lived token: run
  `claude setup-token` on any machine where you're logged in and put the result in `.env` as
  `CLAUDE_CODE_OAUTH_TOKEN`. Or log in interactively with
  `docker compose run --rm advisor claude` (`/login`) and keep `/home/pwuser/.claude` in the
  `claude-home` volume (commented out in `docker-compose.yml`). Check with
  `docker compose run --rm advisor doctor`.

## Phase 2: cloud microVM

Any small Linux VM with Docker works (2 vCPU, 2–4 GB RAM, a few GB of disk; Chrome is the
heaviest part). amd64 gets Google Chrome; arm64 (Graviton, Ampere) gets the bundled Chromium.

1. Copy the repo (or build the image elsewhere and push it to a private registry; the image
   holds no data or secrets) and the `.env` to the VM. Don't copy `.data` or the Mac profile.
2. `docker compose build`, then the hand login **on the VM**, through an SSH tunnel so noVNC
   is never exposed:
   ```bash
   ssh -L 6080:127.0.0.1:6080 vm
   # on the VM:
   docker compose run --rm -p 127.0.0.1:6080:6080 advisor login
   ```
   and open <http://localhost:6080/vnc.html> on the laptop. Logging in from the VM means the
   session is born on the VM's IP, which is what Google will see later.
3. `docker compose run --rm advisor sync`, then `docker compose up -d`.

Expect **re-verification**: Google may challenge or drop a session that is used from a
datacenter IP, more so right after it moves there. When that happens sync records
`session_expired` / `session_missing`, raises an alert, and never tries to log in. Fix it by
stopping the loop and running `login` again through the tunnel. If it happens often, run the
collector from home instead (laptop or a home box), or fall back to the extension route (D3, #16).

Keep the VM private: no published ports (the compose file publishes none; `login` binds noVNC to
the VM's loopback), an encrypted disk if the provider offers one, and backups of the `data`
volume (`/data/app.db` plus `files/`). The `profile` volume holds live Google sessions of the kid
accounts; treat it like a password.
