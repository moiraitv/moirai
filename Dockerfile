FROM node:24.22.1-bookworm-slim AS dependency-base
ENV npm_config_nodedir=/usr/local
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
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

FROM dependency-base AS dependencies
RUN npm ci

FROM dependencies AS build
COPY . .
ARG MOIRAI_SKIP_BUILD_CHECKS=false
RUN case "$MOIRAI_SKIP_BUILD_CHECKS" in \
        false) npm run build:production ;; \
        true) echo 'Skipping dependency audit and documentation approval gates for this image.'; npm run build ;; \
        *) echo >&2 'MOIRAI_SKIP_BUILD_CHECKS must be true or false'; exit 1 ;; \
    esac

FROM dependency-base AS runtime-dependencies
# The embedding worker uses CPU inference. Keep the ONNX binaries for this image's architecture.
RUN npm ci --omit=dev --workspace=@moirai/server \
    && mkdir -p apps/server/node_modules \
    && ort_binaries=node_modules/onnxruntime-node/bin/napi-v3 \
    && ort_target="$ort_binaries/linux/$(node -p 'process.arch')" \
    && test -f "$ort_target/onnxruntime_binding.node" \
    && find "$ort_binaries" -mindepth 2 -maxdepth 2 -type d ! -path "$ort_target" -exec rm -r {} +

FROM node:24.22.1-bookworm-slim AS node-runtime

# ErsatzTV Next v0.2.5 revision c5cb065f9f35dbbcb7c05845f0f92c70f576a480. The
# upstream image index is pinned to prevent an unnoticed engine change.
FROM ghcr.io/ersatztv/next@sha256:4dbf4d7c379b9535505e59773f18d71e89b8823ae07dd859506806cc062a2cf9 AS runtime
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
COPY --from=runtime-dependencies --chown=ersatztv:ersatztv /app/node_modules ./node_modules
COPY --from=runtime-dependencies --chown=ersatztv:ersatztv /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=ersatztv:ersatztv /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=ersatztv:ersatztv /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=ersatztv:ersatztv /app/apps/docs/dist ./apps/web/dist/help
COPY --from=build --chown=ersatztv:ersatztv /app/drizzle ./drizzle
RUN apt-get update \
    && apt-get install --no-install-recommends -y fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --shell /bin/bash ersatztv \
    && mkdir -p /data /backups /home/ersatztv \
    && chown ersatztv:ersatztv /data /backups /home/ersatztv
USER ersatztv
EXPOSE 3000
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "apps/server/dist/main.js"]
