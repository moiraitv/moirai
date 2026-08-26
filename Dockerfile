FROM node:24-bookworm-slim AS dependencies
ENV npm_config_nodedir=/usr/local
WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ersatztv-contract/package.json packages/ersatztv-contract/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS node-runtime

# ErsatzTV Next revision 4eec042fc847aac3799b1d1ab27a4d20f4984575. The
# upstream image currently publishes linux/amd64 only; pinning the index prevents
# an unnoticed engine change.
FROM ghcr.io/ersatztv/next@sha256:24d6f9d0cd7719e495e79e6919a0e898f83a23812642ae39ad99739b6ce3f9eb AS runtime
USER root
ENV NODE_ENV=production \
    MOIRAI_HOST=0.0.0.0 \
    MOIRAI_PORT=3000 \
    MOIRAI_DATA_DIR=/data \
    MOIRAI_ETV_CHANNEL_PATH=/app/ersatztv-channel
COPY --from=node-runtime /usr/local /usr/local
WORKDIR /moirai
COPY --from=build --chown=ersatztv:ersatztv /app/node_modules ./node_modules
COPY --from=build --chown=ersatztv:ersatztv /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=ersatztv:ersatztv /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=ersatztv:ersatztv /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=ersatztv:ersatztv /app/drizzle ./drizzle
RUN mkdir -p /data && chown ersatztv:ersatztv /data
USER ersatztv
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "apps/server/dist/main.js"]
