FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS sdk
WORKDIR /workspace/packages/econ-game-sdk
COPY packages/econ-game-sdk/package.json packages/econ-game-sdk/package-lock.json packages/econ-game-sdk/tsconfig.json ./
RUN npm ci --no-audit --ignore-scripts
COPY packages/econ-game-sdk/src ./src
RUN npm run build

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS base
WORKDIR /workspace/services/bot

COPY --from=sdk /workspace/packages/econ-game-sdk/package.json /workspace/packages/econ-game-sdk/package.json
COPY --from=sdk /workspace/packages/econ-game-sdk/dist /workspace/packages/econ-game-sdk/dist
COPY services/bot/package.json services/bot/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --ignore-scripts; else npm install --no-audit --ignore-scripts; fi

COPY services/bot/tsconfig.json ./
COPY services/bot/src ./src
ENV NEW_RELIC_NO_CONFIG_FILE=true
ENV NEW_RELIC_DISTRIBUTED_TRACING_ENABLED=true
ENV NEW_RELIC_LOG=stdout
RUN npm run build

USER node
CMD ["node", "dist/index.js"]
