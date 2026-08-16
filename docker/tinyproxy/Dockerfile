# Small, auditable tinyproxy image built from a maintained base, rather than
# depending on a third-party Docker Hub image with no recent maintenance
# activity (checked: the common one hasn't been updated in ~5 years).
FROM debian:bookworm-slim

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tinyproxy && \
    rm -rf /var/lib/apt/lists/*

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf

EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
