# Stage 1: Install dependencies and build SvelteKit app
FROM oven/bun:1 AS build

WORKDIR /src

# Copy workspace root files for bun workspace resolution
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/design/package.json packages/design/
COPY apps/web/package.json apps/web/

# Install all dependencies (workspace-aware)
RUN bun install

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/design/ packages/design/
COPY apps/web/ apps/web/

# Build SvelteKit with adapter-node
RUN cd apps/web && bun run build

# Stage 2: Minimal runtime
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/apps/web/build .

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "index.js"]
