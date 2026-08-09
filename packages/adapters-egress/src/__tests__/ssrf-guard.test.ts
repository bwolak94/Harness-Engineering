import { describe, expect, it } from "vitest";
import { isBlockedHostname, isPrivateIp } from "../ssrf-guard.js";

describe("isPrivateIp", () => {
  it("blocks RFC1918 10.x.x.x", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  it("blocks RFC1918 172.16-31.x.x", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    // Outside the range: 172.15 and 172.32 should not be blocked
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("blocks RFC1918 192.168.x.x", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  it("blocks loopback 127.x.x.x", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  it("blocks link-local / AWS metadata 169.254.x.x", () => {
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("104.16.0.1")).toBe(false);
  });

  it("blocks IPv6 loopback ::1", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("blocks IPv6 ULA fc00:: and fd00::", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks well-known metadata hostnames", () => {
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("localhost")).toBe(true);
  });

  it("blocks literal private IP addresses", () => {
    expect(isBlockedHostname("10.0.0.1")).toBe(true);
    expect(isBlockedHostname("192.168.1.1")).toBe(true);
    expect(isBlockedHostname("172.20.0.1")).toBe(true);
  });

  it("allows public hostnames", () => {
    expect(isBlockedHostname("api.example.com")).toBe(false);
    expect(isBlockedHostname("httpbin.org")).toBe(false);
  });

  it("is case-insensitive for hostnames", () => {
    expect(isBlockedHostname("METADATA.GOOGLE.INTERNAL")).toBe(true);
  });
});
