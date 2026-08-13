# Install dependencies separately so application source edits do not invalidate
# the native Sharp dependency layer.
FROM oven/bun:1 AS dependencies
WORKDIR /app
COPY package.json ./
RUN bun install --production

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    VIPS_CONCURRENCY=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
