# Base image matches our pinned playwright-core version and already has all
# the system libs Firefox (and therefore Camoufox, a patched Firefox) needs
# to run headless on Linux - no manual apt-get juggling required.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# camoufox-js depends on better-sqlite3, a native module that needs a
# compiler to build - the Playwright base image is runtime-only.
#
# Real Firefox "headless" mode has weak/no WebGL support regardless of
# installed GL libs (unlike Chromium) - camoufox-js works around this with
# a `headless: 'virtual'` mode that runs Xvfb + true (virtual-display)
# Firefox under the hood, giving it a real GL context to render with
# (libgl1-mesa-dri/libglx-mesa0 provide the software/llvmpipe renderer).
# Camoufox's fingerprint spoofing then relabels that real context (e.g. as
# an NVIDIA GPU) - it can't synthesize a fake one from nothing. Without
# this, WebGL context creation fails entirely and a browser claiming to be
# Windows+Firefox with zero WebGL support at all is a blatant bot signal -
# confirmed empirically: this exact gap was the cause of headless auto-pass
# working reliably on macOS (real WebGL) but failing consistently in plain
# `headless: true` Docker (no WebGL) for the same site/IP.
#
# fonts-liberation/fonts-dejavu-core/fonts-freefont-ttf: the base image has
# very few fonts installed (~50 vs ~2800 font faces on a real desktop) -
# an abnormally small font list is another common headless-bot signal.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    xvfb libgl1-mesa-dri libglx-mesa0 \
    fonts-liberation fonts-dejavu-core fonts-freefont-ttf fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    # fc-list under-counts fonts here due to a fontconfig+overlayfs false
    # positive ("looped directory detected") in the base image's font dirs,
    # which silently skips most of them during cache scanning. Workaround:
    # copy the actual font files into a fresh directory tree fontconfig can
    # scan cleanly (56 -> 103 usable font faces).
    && mkdir -p /usr/local/share/fonts \
    && find /usr/share/fonts -type f \( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' \) -exec cp {} /usr/local/share/fonts/ \; \
    && fc-cache -f /usr/local/share/fonts

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bake the Camoufox browser binary into the image at build time (not into
# the ephemeral home dir) so containers don't need to download ~300MB on
# every cold start. Kept ahead of the source COPYs so editing source
# doesn't invalidate this layer and re-download the browser every build.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN npx camoufox-js fetch

COPY lib ./lib
COPY providers ./providers
COPY server.js get-magnet.js ./

ENV DATA_DIR=/data
ENV PORT=9117
VOLUME ["/data"]
EXPOSE 9117

CMD ["node", "server.js"]
