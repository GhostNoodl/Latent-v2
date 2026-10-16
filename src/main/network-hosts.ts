import { isIP } from 'node:net';

function privateIPv4(address: string) {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * True for loopback, private, link-local and other non-public destinations, so a download
 * request (or one of its redirects) cannot be pointed at the user's own machine or LAN.
 * Hostnames are compared literally; this is a guard against obvious targets, not DNS pinning.
 */
export function isNonPublicHost(hostname: string) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal') || host.endsWith('.home.arpa') || (!host.includes('.') && !isIP(host))) return true;
  const family = isIP(host);
  if (family === 4) return privateIPv4(host);
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return privateIPv4(mapped[1]);
    return (
      host === '::' ||
      host === '::1' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('ff') ||
      host.startsWith('::ffff:')
    );
  }
  return false;
}
