FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS builder
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runner
ARG VERSION
LABEL org.opencontainers.image.version=$VERSION
WORKDIR /app
ENV HOME=/home/bun \
    COPILOT_API_HOME=/home/bun/.local/share/copilot-api

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/pages ./pages

RUN mkdir -p "$COPILOT_API_HOME" \
  && chown -R bun:bun /home/bun \
  && chmod 0700 /home/bun/.local /home/bun/.local/share "$COPILOT_API_HOME"

VOLUME ["/home/bun/.local/share/copilot-api"]
EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:4141/ || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER bun
ENTRYPOINT ["/entrypoint.sh"]
