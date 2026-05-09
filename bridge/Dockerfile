# Builder stage — install build toolchain for native deps (better-sqlite3).
FROM node:20-slim AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ libssl-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Runtime stage — drop the toolchain. better-sqlite3 native build artifacts
# come along inside node_modules.
FROM node:20-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
EXPOSE 3001
CMD ["node", "dist/index.js"]
