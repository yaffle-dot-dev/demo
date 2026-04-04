# Stage 1: Install dependencies
FROM oven/bun:1 AS deps

WORKDIR /src

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/runner/package.json apps/runner/

RUN bun install

# Stage 2: Runtime with infrastructure tools
FROM oven/bun:1-slim

# Install runtime tools: opentofu, awscli, curl, jq, bash, tar, gzip
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      bash \
      tar \
      gzip \
      gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install OpenTofu
RUN curl -fsSL https://get.opentofu.org/install-opentofu.sh -o install-opentofu.sh && \
    chmod +x install-opentofu.sh && \
    ./install-opentofu.sh --install-method deb && \
    rm install-opentofu.sh

# Copy app source and dependencies
WORKDIR /app
COPY --from=deps /src/node_modules node_modules/
COPY --from=deps /src/packages/shared packages/shared/
COPY --from=deps /src/apps/runner/node_modules apps/runner/node_modules/
COPY apps/runner/src apps/runner/src/
COPY apps/runner/package.json apps/runner/
COPY apps/runner/tsconfig.json apps/runner/
COPY packages/shared/ packages/shared/

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV HOME=/tmp

WORKDIR /workspace

CMD ["bun", "run", "/app/apps/runner/src/worker.ts"]
