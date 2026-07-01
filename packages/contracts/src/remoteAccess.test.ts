import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DesktopServerExposureStateSchema } from "./ipc.ts";
import { ServerExposureState, ServerTailscaleServeInput } from "./remoteAccess.ts";

const decodeServerExposureState = Schema.decodeUnknownSync(ServerExposureState);
const decodeServerTailscaleServeInput = Schema.decodeUnknownSync(ServerTailscaleServeInput);
const decodeDesktopServerExposureState = Schema.decodeUnknownSync(DesktopServerExposureStateSchema);

describe("remoteAccess contracts", () => {
  it("validates Tailscale Serve ports on exposure state and input payloads", () => {
    expect(
      decodeServerExposureState({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }).tailscaleServePort,
    ).toBe(443);

    expect(
      decodeServerTailscaleServeInput({
        enabled: true,
        port: 8443,
      }).port,
    ).toBe(8443);

    expect(() =>
      decodeServerExposureState({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 0,
      }),
    ).toThrow();

    expect(() =>
      decodeServerTailscaleServeInput({
        enabled: true,
        port: 65_536,
      }),
    ).toThrow();

    expect(
      decodeDesktopServerExposureState({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }).tailscaleServePort,
    ).toBe(443);

    expect(() =>
      decodeDesktopServerExposureState({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 0,
      }),
    ).toThrow();
  });
});
