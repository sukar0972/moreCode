import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100"]}}`;

const testLayer = Layer.mergeAll(
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die(new Error("unexpected process spawn in test"))),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die(new Error("unexpected HTTP request in test"))),
  ),
);

describe("tailscaleEndpointProvider", () => {
  it.effect("returns private-network IP endpoints only when requested", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        includeIpEndpoints: true,
        serveEnabled: false,
        networkInterfaces: {
          tailscale0: [
            {
              address: "100.100.100.100",
              netmask: "255.192.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "100.100.100.100/10",
            },
            {
              address: "192.168.1.20",
              netmask: "255.255.255.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "192.168.1.20/24",
            },
          ],
        },
        statusJson: null,
      });

      expect(endpoints.map((endpoint) => endpoint.httpBaseUrl)).toEqual([
        "http://100.100.100.100:3773/",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports MagicDNS HTTPS as unavailable until Tailscale Serve is enabled", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        includeIpEndpoints: false,
        serveEnabled: false,
        servePort: 8443,
        networkInterfaces: {},
        statusJson: tailscaleStatusJson,
      });

      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]).toMatchObject({
        label: "Tailscale HTTPS",
        httpBaseUrl: "https://desktop.tail.ts.net:8443/",
        status: "unavailable",
        reachability: "private-network",
        compatibility: {
          hostedHttpsApp: "requires-configuration",
        },
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("marks MagicDNS HTTPS available when Serve is enabled and the probe succeeds", () =>
    Effect.gen(function* () {
      const probedUrls: string[] = [];
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        includeIpEndpoints: false,
        serveEnabled: true,
        servePort: 443,
        networkInterfaces: {},
        statusJson: tailscaleStatusJson,
        probe: (baseUrl) =>
          Effect.sync(() => {
            probedUrls.push(baseUrl);
            return true;
          }),
      });

      expect(probedUrls).toEqual(["https://desktop.tail.ts.net/"]);
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]).toMatchObject({
        httpBaseUrl: "https://desktop.tail.ts.net/",
        status: "available",
        compatibility: {
          hostedHttpsApp: "compatible",
        },
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
