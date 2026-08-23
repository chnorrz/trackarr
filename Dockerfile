# ---------------------------------------------------------------------------
# Builder: installs full deps (needed both to compile TypeScript and for
# camoufox-js's native better-sqlite3 dependency), compiles TS, downloads the
# Camoufox browser, then prunes devDependencies back out. `npm prune` reuses
# what's already installed rather than a second `npm ci`, so nothing gets
# downloaded or natively compiled twice for one image build.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Bake the browser in at build time so containers don't download ~650MB on
# every cold start. CAMOUFOX_INSTALL_DIR keeps it outside the home dir so it
# can be copied into the runtime stage.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN npx camoufox-js fetch

COPY lib ./lib
COPY providers ./providers
COPY scripts ./scripts
COPY server.ts ./
RUN npm run build

RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime: node + the system libraries Firefox needs, and nothing else.
#
# We deliberately do NOT use mcr.microsoft.com/playwright here. That image is
# convenient but ships Chromium, WebKit and its own Firefox (~2.1GB) which we
# never run - Camoufox brings its own browser binary. Instead we install just
# the shared libraries via playwright's install-deps, which resolves them for
# us rather than us hand-maintaining the list.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /opt/camoufox /opt/camoufox
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

# install-deps firefox: the shared libraries Firefox links against, without
# any browser binaries.
#
# xvfb: the browser runs non-headless against a virtual display. Real Firefox
#   "headless" mode has weak/no WebGL regardless of installed GL libs, and a
#   browser claiming to be desktop Firefox with zero WebGL is a blatant bot
#   signal - that gap was why plain headless failed Cloudflare in Docker while
#   working on macOS for the same site/IP.
# libgl1-mesa-dri/libglx-mesa0: the software (llvmpipe) GL renderer that gives
#   Firefox a real WebGL context for Camoufox's spoofing to relabel. It cannot
#   synthesise one from nothing.
# xdotool: drives the Turnstile checkbox at the X server level - see
#   createPointer() in lib/challenge.ts for why Playwright's mouse API is
#   not used.
# fonts-*: an abnormally small font list is another headless-bot signal.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    npx playwright-core install-deps firefox && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb xdotool libgl1-mesa-dri libglx-mesa0 \
      fonts-liberation fonts-dejavu-core fonts-freefont-ttf fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    # fontconfig can silently skip most fonts in a container due to a
    # "looped directory detected" false positive on overlayfs. Copying them
    # into a fresh tree it can scan cleanly avoids that.
    && mkdir -p /usr/local/share/fonts \
    && find /usr/share/fonts -type f \( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' \) -exec cp {} /usr/local/share/fonts/ \; \
    && fc-cache -f /usr/local/share/fonts

COPY --from=builder /app/dist ./


ENV PORT=9117
# The browser runs non-headless against this display. It must be a real size:
# Camoufox's built-in 'virtual' mode uses a 1x1 screen, which leaves nowhere
# to render or click the Turnstile widget.
ENV DISPLAY=:99
EXPOSE 9117

# The lock/socket removal is load-bearing on restart: the container filesystem
# survives `docker restart`, and a leftover /tmp/.X99-lock makes Xvfb refuse to
# start. Every browser launch then dies with "cannot open display: :99" and
# every search fails, permanently. Only a full `docker run` recovered it.
CMD ["bash", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99; Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX & sleep 2 && exec node server.js"]
