# classroom-advisor: `run` loop in a container. See docs/DEPLOY.md.
#
# Volumes: /profile (Chrome user-data-dir, logged in by hand via `login`), /data (SQLite, files).
# The Playwright tag must match the `playwright` version in pnpm-lock.yaml (test/docker.test.ts).
ARG PLAYWRIGHT_VERSION=1.64.0

# --- deps: install node_modules (better-sqlite3 prebuilt, Prisma engines + client) ---
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS deps
ARG PNPM_VERSION=10.30.2
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# postinstall runs `prisma generate`, which loads prisma.config.ts → src/config.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src/config ./src/config
COPY src/store/path.ts ./src/store/path.ts
RUN pnpm install --frozen-lockfile

# --- runtime ---
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION
ARG TARGETARCH
# Set to 1 to bake in the `claude` CLI (llmProvider claude-cli); the default container uses Gemini.
ARG INSTALL_CLAUDE=0

# noVNC stack for the one-time hand login (`login` command): Xvfb + x11vnc + websockify/noVNC.
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify tini \
  && rm -rf /var/lib/apt/lists/*

# Google Chrome stable exists for amd64 only. On arm64 the entrypoint falls back to the
# Chromium bundled in this image (CA_CHROME_CHANNEL=chromium).
RUN if [ "$TARGETARCH" = "amd64" ] || [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      npx -y playwright@${PLAYWRIGHT_VERSION} install chrome; \
    fi

RUN if [ "$INSTALL_CLAUDE" = "1" ]; then npm install -g @anthropic-ai/claude-code; fi

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY --from=deps /app/src/store/generated ./src/store/generated
COPY docker/entrypoint.sh docker/login.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/login.sh \
  && mkdir -p /data /profile \
  && chown pwuser:pwuser /data /profile

# Non-root: `pwuser` (uid 1000) ships with the Playwright image.
USER pwuser
ENV NODE_ENV=production \
    HOME=/home/pwuser \
    CA_PROFILE_DIR=/profile \
    CA_DATA_DIR=/data \
    CA_LLM_PROVIDER=gemini
VOLUME ["/data", "/profile"]
EXPOSE 6080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["run"]
