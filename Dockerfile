FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.mts ./
COPY src ./src
COPY agent ./agent
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    AGENT_DATA_DIR=/data \
    CODEX_HOME=/data/codex

# Temporal Cloud uses TLS. The slim Node image does not include the native CA
# bundle that the Temporal SDK expects, so install it explicitly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/agent ./agent

# Codex command tools start a login shell, which may rebuild PATH rather than
# preserving the SDK process override. Expose the pinned project-local Context
# CLI on the standard container PATH so agent turns and preflight use the same
# installed version.
RUN ln -s /app/node_modules/.bin/context /usr/local/bin/context \
    && mkdir -p /data \
    && chown node:node /data
USER node
VOLUME ["/data"]

CMD ["node", "--enable-source-maps", "dist/index.js"]
