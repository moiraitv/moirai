FROM node:24.22.1-bookworm-slim AS dependencies
ENV npm_config_nodedir=/usr/local
WORKDIR /app
RUN apt-get update || { \
        echo >&2 'APT update failed. If repository signatures are invalid, check Docker disk space with "docker system df" on the host.'; \
        df -h / >&2; \
        exit 1; \
    }; \
    apt-get install --no-install-recommends -y python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ersatztv-contract/package.json packages/ersatztv-contract/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
ARG MOIRAI_SKIP_BUILD_CHECKS=false
RUN case "$MOIRAI_SKIP_BUILD_CHECKS" in \
        false) npm run build:production ;; \
        true) echo 'Skipping dependency audit and documentation approval gates for this image.'; npm run build ;; \
        *) echo >&2 'MOIRAI_SKIP_BUILD_CHECKS must be true or false'; exit 1 ;; \
    esac

FROM node:24.22.1-bookworm-slim AS node-runtime

# ErsatzTV Next v0.2.2 revision 4a0b59a66bef93b908e5eb2086847418492e2555. The
# upstream image index is pinned to prevent an unnoticed engine change.
FROM ghcr.io/ersatztv/next@sha256:f0a975ae926a3640b0f024b210a2a1dc8850f8dfa974503db38578e4f3a291ba AS runtime
USER root
ENV NODE_ENV=production \
    HOME=/home/ersatztv \
    MOIRAI_HOST=0.0.0.0 \
    MOIRAI_PORT=3000 \
    MOIRAI_DATA_DIR=/data \
    MOIRAI_BACKUP_DIR=/backups \
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
    && mkdir -p /data /backups /home/ersatztv \
    && chown ersatztv:ersatztv /data /backups /home/ersatztv
USER ersatztv
EXPOSE 3000
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "apps/server/dist/main.js"]
