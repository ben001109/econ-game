FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --ignore-scripts; else npm install --no-audit --ignore-scripts; fi

COPY tsconfig.json ./
COPY src ./src
ENV NEW_RELIC_NO_CONFIG_FILE=true
ENV NEW_RELIC_DISTRIBUTED_TRACING_ENABLED=true
ENV NEW_RELIC_LOG=stdout
RUN npm run build

CMD ["node", "dist/index.js"]

