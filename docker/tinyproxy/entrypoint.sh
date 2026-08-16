#!/bin/sh
set -eu

# Only the Allow-listed subnet is exposed as configurable - Port/Listen stay
# fixed because docker-compose.yml's PROXY_URL hardcodes tinyproxy:8888;
# making the port configurable too would just add a second place to keep
# those two files in sync for no real benefit.
: "${ALLOWED_SUBNET:=172.28.99.0/24}"
export ALLOWED_SUBNET

envsubst '${ALLOWED_SUBNET}' < /etc/tinyproxy/tinyproxy.conf.template > /etc/tinyproxy/tinyproxy.conf

exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
