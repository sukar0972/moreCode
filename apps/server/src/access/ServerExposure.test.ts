import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import { HttpClient, HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerExposure, layer as ServerExposureLayer } from "./ServerExposure.ts";

const encoder = new TextEncoder();

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockHandle({}));
    }),
  );
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
}) {
  return ServerExposureLayer.pipe(
    Layer.provide(makeConfigLayer(input.config ?? {})),
    Layer.provide(makeHttpServerLayer(input.port ?? 3773)),
    Layer.provide(makeSpawnerLayer(input.commands ?? [])),
    Layer.provide(makeHttpClientLayer()),
  );
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

  it.effect("uses loopback as the Tailscale Serve target even when the server binds to LAN", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const exposure = yield* ServerExposure;
      const state = yield* exposure.setTailscaleServeEnabled({
        enabled: true,
        port: 9443,
      });

      expect(state.tailscaleServeEnabled).toBe(true);
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
    );
  });
});
