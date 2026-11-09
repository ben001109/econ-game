FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS builder
WORKDIR /workspace/services/api
COPY services/api/package.json services/api/package-lock.json* ./
COPY packages/econ-game-release-evidence /workspace/packages/econ-game-release-evidence
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
RUN apk add --no-cache openssl1.1-compat || apk add --no-cache openssl
COPY services/api/tsconfig.json ./
COPY services/api/prisma ./prisma
COPY services/api/src ./src
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS runner
WORKDIR /workspace/services/api
ENV NODE_ENV=production
COPY services/api/package.json services/api/package-lock.json* ./
COPY packages/econ-game-release-evidence /workspace/packages/econ-game-release-evidence
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
RUN apk add --no-cache openssl1.1-compat || apk add --no-cache openssl
COPY --from=builder /workspace/services/api/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /workspace/services/api/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /workspace/services/api/prisma ./prisma
COPY --from=builder /workspace/services/api/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
ENV NEW_RELIC_NO_CONFIG_FILE=true
ENV NEW_RELIC_DISTRIBUTED_TRACING_ENABLED=true
ENV NEW_RELIC_LOG=stdout
