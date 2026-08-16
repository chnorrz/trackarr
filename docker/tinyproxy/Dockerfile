# Small, auditable tinyproxy image built from a maintained base, rather than
# depending on a third-party Docker Hub image with no recent maintenance
# activity (checked: the common one hasn't been updated in ~5 years).
FROM debian:bookworm-slim

# gettext-base provides envsubst, used to fill in ALLOWED_SUBNET at start.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tinyproxy gettext-base && \
    rm -rf /var/lib/apt/lists/*

COPY tinyproxy.conf.template /etc/tinyproxy/tinyproxy.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8888
ENTRYPOINT ["/entrypoint.sh"]
