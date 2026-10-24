FROM node:24-bookworm-slim AS platform-tools
ARG TARGETARCH
ARG PLATFORM_TOOLS_VERSION=37.0.1
RUN test "$TARGETARCH" = "amd64" \
    || (echo "Google Platform Tools requires linux/amd64. Build with --platform=linux/amd64." && exit 1)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl --fail --location --retry 3 \
       "https://dl.google.com/android/repository/platform-tools_r${PLATFORM_TOOLS_VERSION}-linux.zip" \
       --output /tmp/platform-tools.zip \
    && unzip -q /tmp/platform-tools.zip -d /opt

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libusb-1.0-0 tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/node/.android /home/node/data \
    && chown node:node /home/node/.android /home/node/data

WORKDIR /app
COPY --from=platform-tools /opt/platform-tools /opt/platform-tools
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 HOME=/home/node DATA_DIR=/home/node/data
ENV PATH="/opt/platform-tools:${PATH}"
RUN adb version && adb help 2>&1 | grep -q 'pair HOST'
USER node
EXPOSE 3000
VOLUME ["/home/node/.android", "/home/node/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
