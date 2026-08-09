/**
 * SSRF guard — IP address and hostname blocklist.
 *
 * Checks resolved IP addresses against:
 *   - RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - Loopback (127/8, ::1)
 *   - Link-local (169.254/16 — AWS/GCP metadata endpoints)
 *   - IPv6 ULA (fc00::/7)
 *
 * This is defence-in-depth: the production network layer (K8s NetworkPolicy)
 * provides the primary SSRF defence. This function prevents application-level
 * bypasses and catches misconfigured tools earlier (at the SDK level).
 */

import { isIPv4, isIPv6 } from "node:net";

// ---------------------------------------------------------------------------
// Blocked hostnames (exact match, lower-case)
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.aws.internal",
  "169.254.169.254",
  "fd00:ec2::254",
  "localhost",
]);

// ---------------------------------------------------------------------------
// IP range checks (IPv4 only; IPv6 private ranges handled by prefix check)
// ---------------------------------------------------------------------------

interface Ipv4Range {
  base: number;
  mask: number;
}

/** Convert a dotted-decimal IPv4 string to a 32-bit integer. */
function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0;
}

/** Build an IPv4 range from CIDR notation (e.g. "10.0.0.0/8"). */
function cidr4(notation: string): Ipv4Range {
  const [addr, bits] = notation.split("/") as [string, string];
  const prefixLen = Number(bits);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { base: ipv4ToInt(addr) & mask, mask };
}

const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = [
  cidr4("10.0.0.0/8"),
  cidr4("172.16.0.0/12"),
  cidr4("192.168.0.0/16"),
  cidr4("127.0.0.0/8"),
  cidr4("169.254.0.0/16"),
  cidr4("100.64.0.0/10"), // CGNAT — shared address space, sometimes used for metadata
  cidr4("0.0.0.0/8"),
];

/** Returns true if `ip` (dotted-decimal) falls in any blocked IPv4 CIDR. */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some((r) => (n & r.mask) === r.base);
}

/** Returns true if `ip` is a blocked IPv6 address. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1") return true;
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped: e.g. ::ffff:10.0.0.1 — extract and check IPv4 part
    const v4 = lower.slice(7);
    if (isIPv4(v4)) return isBlockedIpv4(v4);
  }
  // IPv6 ULA (fc00::/7 covers fc00:: and fd00::)
  if (/^f[cd]/i.test(lower)) return true;
  // Link-local (fe80::/10)
  if (/^fe[89ab]/i.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if `ip` (the result of a DNS lookup) must be blocked.
 * Call this with every resolved address before making a connection.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedIpv4(ip);
  if (isIPv6(ip)) return isBlockedIpv6(ip);
  return false; // unknown format — let the connection attempt fail naturally
}

/**
 * Returns true if `hostname` matches a known blocked literal (not via DNS).
 * Use this for static validation at tool-save time.
 */
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  // A literal IP address in the hostname position
  if (isIPv4(lower)) return isBlockedIpv4(lower);
  if (isIPv6(lower.replace(/^\[|\]$/g, ""))) return isBlockedIpv6(lower);
  return false;
}
