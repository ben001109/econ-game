FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS sdk
WORKDIR /workspace/packages/econ-game-sdk
COPY packages/econ-game-sdk/package.json packages/econ-game-sdk/package-lock.json packages/econ-game-sdk/tsconfig.json ./
RUN npm ci --no-audit --ignore-scripts
COPY packages/econ-game-sdk/src ./src
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
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
