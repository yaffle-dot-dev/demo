# Stage 1: Install dependencies and bundle
FROM oven/bun:1 AS build

WORKDIR /src

# Copy workspace root files for bun workspace resolution
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/control-plane/package.json apps/control-plane/

# Install all dependencies (workspace-aware)
RUN bun install

# Copy source
COPY packages/shared/ packages/shared/
COPY apps/control-plane/ apps/control-plane/

# Bundle the control plane
# --external minijinja-js: WASM module that doesn't bundle correctly
RUN mkdir -p /bundle/node_modules && \
    NODE_ENV=production bun build apps/control-plane/src/index.ts \
      --outdir /bundle \
      --target bun \
      --external minijinja-js && \
    cp -r node_modules/.bun/minijinja-js@*/node_modules/minijinja-js /bundle/node_modules/

# Stage 2: Minimal runtime
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /bundle .

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "index.js"]
