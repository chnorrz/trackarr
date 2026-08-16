#!/usr/bin/env node

/**
 * Minimal HTTP CONNECT proxy, run on the macOS HOST.
 *
 * Why this exists: 1337x has banned our IPv4 address but not our IPv6 one.
 * macOS has working IPv6, but Colima's Linux VM has none at all (no global
 * addresses, no egress), so containers fall back to the banned IPv4. Docker's
 * own IPv6 support can't fix that - the VM simply cannot route IPv6.
 *
 * Tunnelling through here sends the traffic out over the host's IPv6 instead.
 * Because CONNECT only pipes bytes, TLS stays end-to-end between the browser
 * and the target, so the browser's TLS fingerprint is unchanged - only the
 * egress address differs.
 *
 * Usage (on the host):
 *   node tools/ipv6-proxy.js            # listens on 0.0.0.0:8888
 *
 * From a container, reach it at http://host.docker.internal:8888
 */

import net from 'net';
import http from 'http';

const PORT = Number(process.env.PROXY_PORT) || 8888;

const server = http.createServer((req, res) => {
  // Plain HTTP proxying isn't needed - everything we tunnel is HTTPS.
  res.writeHead(405);
  res.end('CONNECT only');
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;

  // family: 6 forces the AAAA record. Node's default (Happy Eyeballs) would
  // often pick IPv4, which is the address that's banned - defeating the
  // entire point of this proxy.
  const connect = (family) => {
    const upstream = net.connect({ host, port, family }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      if (family === 6) {
        // No AAAA record (or IPv6 path broken) - fall back rather than fail.
        console.error(`[proxy] ${host}: IPv6 failed (${err.code}), retrying IPv4`);
        connect(4);
        return;
      }
      console.error(`[proxy] ${host}: ${err.message}`);
      clientSocket.destroy();
    });

    upstream.on('connect', () => {
      console.error(`[proxy] ${host}:${port} via IPv${family}`);
    });
  };

  clientSocket.on('error', () => {});
  connect(6);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CONNECT proxy listening on 0.0.0.0:${PORT} (prefers IPv6)`);
});
