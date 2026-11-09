FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS builder
WORKDIR /workspace/services/worker
COPY services/worker/package.json services/worker/package-lock.json* ./
COPY packages/econ-game-release-evidence /workspace/packages/econ-game-release-evidence
RUN npm set progress=false \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 600000 \
  && npm config set fetch-retries 5 \
  && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY services/worker/tsconfig.json ./
COPY services/worker/prisma ./prisma
COPY services/worker/src ./src
RUN ./node_modules/.bin/prisma generate && npm run build

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS runner
WORKDIR /workspace/services/worker
ENV NODE_ENV=production
ENV NEW_RELIC_NO_CONFIG_FILE=true
ENV NEW_RELIC_DISTRIBUTED_TRACING_ENABLED=true
ENV NEW_RELIC_LOG=stdout
COPY services/worker/package.json services/worker/package-lock.json* ./
COPY packages/econ-game-release-evidence /workspace/packages/econ-game-release-evidence
RUN npm set progress=false \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 600000 \
  && npm config set fetch-retries 5 \
  && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=builder /workspace/services/worker/dist ./dist
COPY --from=builder /workspace/services/worker/node_modules/.prisma ./node_modules/.prisma
USER node
EXPOSE 4001
CMD ["node", "dist/index.js"]
