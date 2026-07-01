import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpServer } from "effect/unstable/http";
import { mockChildProcessSpawnerLayer } from "@t3tools/tailscale/testing";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerExposure, layer as ServerExposureLayer } from "./ServerExposure.ts";

const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100"]}}`;

type SpawnerHandler = (
  command: string,
  args: ReadonlyArray<string>,
) => { stdout?: string; stderr?: string; code?: number };

function makeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  handler: SpawnerHandler = () => ({}),
) {
  return mockChildProcessSpawnerLayer(handler, { commands });
}

function makeHttpServerLayer(port: number) {
  return Layer.succeed(HttpServer.HttpServer, {
    address: {
      _tag: "TcpAddress",
      hostname: "127.0.0.1",
      port,
    },
  } as unknown as HttpServer.HttpServer["Service"]);
}

function makeHttpClientLayer() {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die(new Error("unexpected HTTP request in ServerExposure test"))),
  );
}

function makeConfigLayer(overrides: Partial<ServerConfigShape>) {
  const baseDir = "/tmp/server-exposure-test";
  return Layer.succeed(ServerConfig, {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    cwd: process.cwd(),
    baseDir,
    stateDir: `${baseDir}/state`,
    dbPath: `${baseDir}/state/state.sqlite`,
    keybindingsConfigPath: `${baseDir}/state/keybindings.json`,
    settingsPath: `${baseDir}/state/settings.json`,
    providerStatusCacheDir: `${baseDir}/caches`,
    worktreesDir: `${baseDir}/worktrees`,
    attachmentsDir: `${baseDir}/state/attachments`,
    sectionsDir: `${baseDir}/state/sections`,
    logsDir: `${baseDir}/state/logs`,
    serverLogPath: `${baseDir}/state/logs/server.log`,
    serverTracePath: `${baseDir}/state/logs/server.trace.ndjson`,
    providerLogsDir: `${baseDir}/state/logs/provider`,
    providerEventLogPath: `${baseDir}/state/logs/provider/events.log`,
    terminalLogsDir: `${baseDir}/state/logs/terminals`,
    anonymousIdPath: `${baseDir}/state/anonymous-id`,
    environmentIdPath: `${baseDir}/state/environment-id`,
    serverRuntimeStatePath: `${baseDir}/state/server-runtime.json`,
    secretsDir: `${baseDir}/state/secrets`,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    startupPresentation: "browser",
    ...overrides,
  } satisfies ServerConfigShape);
}

function makeLayer(input: {
  readonly config?: Partial<ServerConfigShape>;
  readonly port?: number;
  readonly commands?: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly spawnerHandler?: SpawnerHandler;
}) {
  return ServerExposureLayer.pipe(
    Layer.provide(makeConfigLayer(input.config ?? {})),
    Layer.provide(makeHttpServerLayer(input.port ?? 3773)),
    Layer.provide(makeSpawnerLayer(input.commands ?? [], input.spawnerHandler)),
    Layer.provide(makeHttpClientLayer()),
  );
}

function tailscaleStatusHandler(command: string, args: ReadonlyArray<string>) {
  if (command === "tailscale" && args[0] === "status") {
    return { stdout: tailscaleStatusJson };
  }
  return {};
}

describe("ServerExposure", () => {
  it.effect("treats the default undefined host as local-only", () =>
    Effect.gen(function* () {
      const exposure = yield* ServerExposure;
      const state = yield* exposure.getState;

      expect(state).toMatchObject({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect("uses the shared remote-reachable host policy for explicit LAN hosts", () =>
    Effect.gen(function* () {
      const exposure = yield* ServerExposure;
      const state = yield* exposure.getState;

      expect(state).toMatchObject({
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.20:4111",
        advertisedHost: "192.168.1.20",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          port: 4111,
          config: {
            host: "192.168.1.20",
          },
        }),
      ),
    ),
  );

  it.effect(
    "configures and cleans up startup-enabled Tailscale Serve through one lifecycle",
    () => {
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];

      return Effect.scoped(
        Effect.gen(function* () {
          const exposure = yield* ServerExposure;
          expect((yield* exposure.getState).tailscaleServeEnabled).toBe(true);
        }).pipe(
          Effect.provide(
            makeLayer({
              port: 13773,
              commands,
              config: {
                tailscaleServeEnabled: true,
                tailscaleServePort: 8443,
              },
            }),
          ),
        ),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(commands).toEqual([
              {
                command: "tailscale",
                args: ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
              },
              {
                command: "tailscale",
                args: ["serve", "--https=8443", "off"],
              },
            ]);
          }),
        ),
      );
    },
  );

  it.effect("reports Tailscale Serve disabled when startup configure fails", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
      [];

    return Effect.scoped(
      Effect.gen(function* () {
        const exposure = yield* ServerExposure;
        const state = yield* exposure.getState;

        expect(state).toMatchObject({
          tailscaleServeEnabled: false,
          tailscaleServePort: 8443,
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            port: 13773,
            commands,
            config: {
              tailscaleServeEnabled: true,
              tailscaleServePort: 8443,
            },
            spawnerHandler: () => ({ code: 1, stderr: "tailscale: command not found" }),
          }),
        ),
      ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(commands).toEqual([
            {
              command: "tailscale",
              args: ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
            },
          ]);
        }),
      ),
    );
  });

  it.effect("composes core and Tailscale advertised endpoints", () =>
    Effect.gen(function* () {
      const exposure = yield* ServerExposure;
      const endpoints = yield* exposure.getAdvertisedEndpoints;

      expect(endpoints.map((endpoint) => endpoint.httpBaseUrl)).toContain(
        "http://127.0.0.1:3773/",
      );
      expect(endpoints.some((endpoint) => endpoint.label === "This machine")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.label === "Tailscale HTTPS")).toBe(true);
      expect(
        endpoints.find((endpoint) => endpoint.label === "Tailscale HTTPS"),
      ).toMatchObject({
        httpBaseUrl: "https://desktop.tail.ts.net/",
        status: "unavailable",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          port: 3773,
          spawnerHandler: tailscaleStatusHandler,
        }),
      ),
    ),
  );

  it.effect("uses loopback as the Tailscale Serve target even when the server binds to LAN", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.scoped(
      Effect.gen(function* () {
        const exposure = yield* ServerExposure;
        const state = yield* exposure.setTailscaleServeEnabled({
          enabled: true,
          port: 9443,
        });

        expect(state).toMatchObject({
          tailscaleServeEnabled: true,
          tailscaleServePort: 9443,
        });
        expect(commands[0]).toEqual({
          command: "tailscale",
          args: ["serve", "--bg", "--https=9443", "http://127.0.0.1:13773"],
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            port: 13773,
            commands,
            config: {
              host: "192.168.1.20",
            },
          }),
        ),
      ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(commands).toEqual([
            {
              command: "tailscale",
              args: ["serve", "--bg", "--https=9443", "http://127.0.0.1:13773"],
            },
            {
              command: "tailscale",
              args: ["serve", "--https=9443", "off"],
            },
          ]);
        }),
      ),
    );
  });
});