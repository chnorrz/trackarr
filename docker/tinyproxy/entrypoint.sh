#!/bin/sh
set -eu

# Only the Allow-listed subnet is exposed as configurable - Port/Listen stay
# fixed because docker-compose.yml's PROXY_URL hardcodes tinyproxy:8888;
# making the port configurable too would just add a second place to keep
# those two files in sync for no real benefit.
: "${ALLOWED_SUBNET:=172.28.99.0/24}"
export ALLOWED_SUBNET

envsubst '${ALLOWED_SUBNET}' < /etc/tinyproxy/tinyproxy.conf.template > /etc/tinyproxy/tinyproxy.conf

# Force outgoing connections onto IPv6, for deployments where a tracker has
# banned this host's IPv4 but not its IPv6 (see NOTES.md). Binding tinyproxy's
# own outgoing socket to its container's IPv6 address is what actually forces
# this - IPv4/IPv6 dual-stack racing otherwise picks whichever connects
# fastest, with no awareness that one path leads to a ban.
#
# Reads /proc/net/if_inet6 directly rather than shelling out to `ip` - this
# image's base doesn't include iproute2, and this needs no extra package.
# Each line is "<32-hex-char address, no colons> <netlink dev> <prefix len>
# <scope> <flags> <device>" - scope 00 is global, 10 is link-local.
#
# Colon insertion uses an explicit substr/loop rather than a regex interval
# like /(.{4})/ - this image's awk is mawk, which silently ignores {n}
# interval quantifiers instead of erroring, so that version compiled but
# left the address as one unbroken hex string with no colons at all.
if [ "${FORCE_IPV6:-false}" = "true" ]; then
  OWN_IPV6=$(awk '$4 == "00" {
    a = $1; out = "";
    for (i = 1; i <= length(a); i += 4) {
      out = out substr(a, i, 4);
      if (i + 4 <= length(a)) out = out ":";
    }
    print out; exit
  }' /proc/net/if_inet6)
  if [ -n "$OWN_IPV6" ]; then
    echo "Bind $OWN_IPV6" >> /etc/tinyproxy/tinyproxy.conf
    echo "[entrypoint] FORCE_IPV6 set - binding outgoing connections to $OWN_IPV6"
  else
    echo "[entrypoint] FORCE_IPV6 set but no global IPv6 address found on this container - ignoring"
  fi
fi

exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
