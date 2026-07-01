import { assert, expect, it } from "@effect/vitest";

import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  formatStartupAccessOutput,
  isRemoteReachableHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveLanConnectionHost,
  resolveLanConnectionString,
  resolveListeningPort,
  resolveLocalConnectionString,
  resolveServerAdvertisedHost,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("treats undefined and loopback hosts as local-only for remote reachability", () => {
  expect(isRemoteReachableHost(undefined)).toBe(false);
  expect(isRemoteReachableHost("127.0.0.1")).toBe(false);
  expect(isRemoteReachableHost("localhost")).toBe(false);
  expect(isRemoteReachableHost("0.0.0.0")).toBe(true);
  expect(isRemoteReachableHost("192.168.1.42")).toBe(true);
});

it("resolves server advertised hosts only when the bind address is remote-reachable", () => {
  const interfaces = {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
        scopeid: 0,
      },
    ],
  };

  expect(resolveServerAdvertisedHost(undefined, interfaces)).toBe(null);
  expect(resolveServerAdvertisedHost("127.0.0.1", interfaces)).toBe(null);
  expect(resolveServerAdvertisedHost("192.168.1.10", interfaces)).toBe("192.168.1.10");
  expect(resolveServerAdvertisedHost("0.0.0.0", interfaces)).toBe("192.168.1.42");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
        scopeid: 0,
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("resolves a LAN connection string from the first external IPv4 interface", () => {
  const interfaces = {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
        scopeid: 0,
      },
    ],
  };

  expect(resolveLanConnectionHost(interfaces)).toBe("192.168.1.42");
  expect(resolveLanConnectionString(3773, interfaces)).toBe("http://192.168.1.42:3773");
  expect(resolveLocalConnectionString(3773)).toBe("http://localhost:3773");
});

it("formats startup output with local and LAN pairing URLs", () => {
  const output = formatStartupAccessOutput({
    token: "PAIRCODE",
    localPairingUrl: "http://localhost:3773/pair#token=PAIRCODE",
    lanPairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Local pairing URL: http://localhost:3773/pair#token=PAIRCODE");
  expect(output).toContain("LAN pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

it("formats legacy headless serve output through the startup formatter", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Local pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  expect(output).not.toContain("LAN pairing URL:");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});
