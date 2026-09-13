FROM node:24-bookworm-slim AS dependencies
ENV npm_config_nodedir=/usr/local
WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ersatztv-contract/package.json packages/ersatztv-contract/package.json
RUN npm ci

FROM dependencies AS build
RUN apt-get update \
    && apt-get install --no-install-recommends -y git \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build:production

FROM node:24-bookworm-slim AS node-runtime

# ErsatzTV Next revision 11a9fe8f8f383eab2de83f2173019cde34726830. The
# upstream image currently publishes linux/amd64 only; pinning the index prevents
# an unnoticed engine change.
FROM ghcr.io/ersatztv/next@sha256:7d622e0d4febabca102386c15682d4410b5abf494a654387f997ed36b3fbc7b1 AS runtime
USER root
ENV NODE_ENV=production \
    HOME=/home/ersatztv \
    MOIRAI_HOST=0.0.0.0 \
    MOIRAI_PORT=3000 \
    MOIRAI_DATA_DIR=/data \
    MOIRAI_ETV_CHANNEL_PATH=/app/ersatztv-channel
COPY --from=node-runtime /usr/local /usr/local
WORKDIR /moirai
COPY --from=build --chown=ersatztv:ersatztv /app/package.json ./package.json
COPY --from=build --chown=ersatztv:ersatztv /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=ersatztv:ersatztv /app/node_modules ./node_modules
COPY --from=build --chown=ersatztv:ersatztv /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=ersatztv:ersatztv /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=ersatztv:ersatztv /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=ersatztv:ersatztv /app/apps/docs/dist ./apps/web/dist/help
COPY --from=build --chown=ersatztv:ersatztv /app/drizzle ./drizzle
RUN usermod --shell /bin/bash ersatztv \
    && mkdir -p /data /home/ersatztv \
    && chown ersatztv:ersatztv /data /home/ersatztv
USER ersatztv
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "apps/server/dist/main.js"]
