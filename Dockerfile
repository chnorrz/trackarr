# Base image matches our pinned playwright-core version and already has all
# the system libs Firefox (and therefore Camoufox, a patched Firefox) needs
# to run headless on Linux - no manual apt-get juggling required.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# camoufox-js depends on better-sqlite3, a native module that needs a
# compiler to build - the Playwright base image is runtime-only.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY server.js get-magnet.js ./

# Bake the Camoufox browser binary into the image at build time (not into
# the ephemeral home dir) so containers don't need to download ~300MB on
# every cold start.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN npx camoufox-js fetch

ENV DATA_DIR=/data
ENV PORT=9117
VOLUME ["/data"]
EXPOSE 9117

CMD ["node", "server.js"]
