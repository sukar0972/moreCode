import * as NodeOS from "node:os";

import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
  ServerExposureError,
  type ServerExposureState,
  type ServerTailscaleServeInput,
} from "@t3tools/contracts";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpServer } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../config.ts";
import {
  formatHostForUrl,
  isRemoteReachableHost,
  resolveListeningPort,
  resolveServerAdvertisedHost,
} from "../startupAccess.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const SERVER_LOOPBACK_HOST = "127.0.0.1";

const SERVER_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "server-core",
  label: "Server",
  kind: "core",
  isAddon: false,
};

interface TailscaleServeState {
  readonly enabled: boolean;
  readonly port: number;
}

function resolveEndpointUrl(host: string | null, port: number): string | null {
  return host ? `http://${formatHostForUrl(host)}:${port}` : null;
}

function localBaseUrl(port: number): string {
  return `http://${SERVER_LOOPBACK_HOST}:${port}`;
}

function makeState(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly tailscale: TailscaleServeState;
}): ServerExposureState {
  const advertisedHost = resolveServerAdvertisedHost(input.host);
  const endpointUrl = resolveEndpointUrl(advertisedHost, input.port);
  return {
    mode: isRemoteReachableHost(input.host) ? "network-accessible" : "local-only",
    endpointUrl,
    advertisedHost,
    tailscaleServeEnabled: input.tailscale.enabled,
    tailscaleServePort: input.tailscale.port,
  };
}

function createServerEndpoint(
  input: Omit<
    Parameters<typeof createAdvertisedEndpoint>[0],
    "provider" | "source" | "desktopCompatibility"
  >,
): AdvertisedEndpoint {
  return createAdvertisedEndpoint({
    ...input,
    provider: SERVER_CORE_ENDPOINT_PROVIDER,
    source: "server",
    desktopCompatibility: "compatible",
  });
}

function resolveCoreAdvertisedEndpoints(input: {
  readonly state: ServerExposureState;
  readonly port: number;
}): readonly AdvertisedEndpoint[] {
  const endpoints: AdvertisedEndpoint[] = [
    createServerEndpoint({
      id: `server-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: localBaseUrl(input.port),
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this server.",
    }),
  ];

  if (input.state.endpointUrl) {
    endpoints.push(
      createServerEndpoint({
        id: `server-lan:${input.state.endpointUrl}`,
        label: "Local network",
        httpBaseUrl: input.state.endpointUrl,
        reachability: "lan",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      }),
    );
  }

  return endpoints;
}

export class ServerExposure extends Context.Service<
  ServerExposure,
  {
    readonly getState: Effect.Effect<ServerExposureState, ServerExposureError>;
    readonly getAdvertisedEndpoints: Effect.Effect<
      readonly AdvertisedEndpoint[],
      ServerExposureError
    >;
    readonly setTailscaleServeEnabled: (
      input: ServerTailscaleServeInput,
    ) => Effect.Effect<ServerExposureState, ServerExposureError>;
  }
>()("t3/access/ServerExposure") {}

export const make = Effect.fn("makeServerExposure")(function* () {
  const config = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const port = resolveListeningPort(httpServer.address, config.port);
  const tailscaleRef = yield* Ref.make<TailscaleServeState>({
    enabled: config.tailscaleServeEnabled,
    port: config.tailscaleServePort,
  });

  const readMagicDnsName: Effect.Effect<string | null, never, never> = readTailscaleStatus.pipe(
    Effect.map((status) => status.magicDnsName),
    Effect.orElseSucceed(() => null),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
  );

  if (config.tailscaleServeEnabled) {
    yield* ensureTailscaleServe({
      localPort: port,
      servePort: config.tailscaleServePort,
      localHost: SERVER_LOOPBACK_HOST,
    }).pipe(
      Effect.tap(() =>
        Effect.logInfo("Tailscale Serve configured", {
          localPort: port,
          servePort: config.tailscaleServePort,
        }),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Failed to configure Tailscale Serve", {
            cause,
            localPort: port,
            servePort: config.tailscaleServePort,
          });
          yield* Ref.set(tailscaleRef, {
            enabled: false,
            port: config.tailscaleServePort,
          });
        }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );
  }

  const getState = Ref.get(tailscaleRef).pipe(
    Effect.map((tailscale) => makeState({ host: config.host, port, tailscale })),
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* getState;
    const coreEndpoints = resolveCoreAdvertisedEndpoints({ state, port });
    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port,
      includeIpEndpoints: state.mode === "network-accessible",
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: NodeOS.networkInterfaces(),
      readMagicDnsName,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerExposureError({
            operation: "read",
            message: "Failed to resolve Tailscale endpoints.",
            cause,
          }),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );
    return [...coreEndpoints, ...tailscaleEndpoints];
  }).pipe(Effect.withSpan("serverExposure.getAdvertisedEndpoints"));

  const setTailscaleServeEnabled = Effect.fn("serverExposure.setTailscaleServeEnabled")(function* (
    input: ServerTailscaleServeInput,
  ) {
    const current = yield* Ref.get(tailscaleRef);
    const servePort = input.port ?? current.port;

    if (input.enabled) {
      yield* ensureTailscaleServe({
        localPort: port,
        servePort,
        localHost: SERVER_LOOPBACK_HOST,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerExposureError({
              operation: "tailscale-serve",
              message: cause.message,
              cause,
            }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
    } else {
      yield* disableTailscaleServe({ servePort }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerExposureError({
              operation: "tailscale-serve",
              message: cause.message,
              cause,
            }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
    }

    const tailscale = { enabled: input.enabled, port: servePort };
    yield* Ref.set(tailscaleRef, tailscale);
    return makeState({ host: config.host, port, tailscale });
  });

  yield* Effect.addFinalizer(() =>
    Ref.get(tailscaleRef).pipe(
      Effect.flatMap((tailscale) =>
        tailscale.enabled
          ? disableTailscaleServe({ servePort: tailscale.port }).pipe(
              Effect.tap(() =>
                Effect.logInfo("Tailscale Serve disabled", {
                  servePort: tailscale.port,
                }),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to disable Tailscale Serve", {
                  cause,
                  servePort: tailscale.port,
                }),
              ),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            )
          : Effect.void,
      ),
    ),
  );

  return ServerExposure.of({
    getState,
    getAdvertisedEndpoints,
    setTailscaleServeEnabled,
  });
});

export const layer = Layer.effect(ServerExposure, make());