// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { DesktopBackendBootstrap } from "@t3tools/contracts";

export const UI_SMOKE_BOOTSTRAP_TOKEN = "ui-smoke-bootstrap-token";
export const UI_SMOKE_PAIRING_TOKEN_PATTERN = /pair#token=([A-Z0-9]+)/;
export const UI_SMOKE_DEFAULT_PORT = 14_773;
export const UI_SMOKE_ROOT_ERROR_TEXT = "Something went wrong.";
export const UI_SMOKE_WS_ERROR_TEXT = "Unable to connect to the T3 server WebSocket.";
export const UI_SMOKE_READY_TEXT = "Pick a thread to continue";

export interface UiSmokeBuildPaths {
  readonly serverBin: string;
  readonly clientIndex: string;
}

export function resolveUiSmokeBuildPaths(repoRoot: string): UiSmokeBuildPaths {
  const serverDist = join(repoRoot, "apps/server/dist");
  return {
    serverBin: join(serverDist, "bin.mjs"),
    clientIndex: join(serverDist, "client/index.html"),
  };
}

export function assertUiSmokeBuildAssets(paths: UiSmokeBuildPaths): void {
  const missing = [
    !existsSync(paths.serverBin) ? paths.serverBin : null,
    !existsSync(paths.clientIndex) ? paths.clientIndex : null,
  ].filter((path): path is string => path !== null);

  if (missing.length > 0) {
    throw new Error(
      `UI smoke requires a production build. Missing:\n${missing.map((path) => `- ${path}`).join("\n")}\nRun: vp run build`,
    );
  }
}

export function resolveAvailableTcpPort(
  host: string,
  preferredPort: number,
  maxAttempts = 20,
): Promise<number> {
  const attempt = (port: number, attemptsLeft: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        server.close();
        if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
          void attempt(port + 1, attemptsLeft - 1).then(resolve, reject);
          return;
        }
        reject(error);
      });
      server.listen(port, host, () => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve(port);
        });
      });
    });

  return attempt(preferredPort, maxAttempts);
}

export function resolveUiSmokePort(rawValue: string | undefined): number {
  if (!rawValue?.trim()) {
    return UI_SMOKE_DEFAULT_PORT;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid UI smoke port: ${rawValue}`);
  }

  return parsed;
}

export function makeUiSmokeBootstrap(input: {
  readonly port: number;
  readonly t3Home: string;
  readonly host?: string;
  readonly bootstrapToken?: string;
}): DesktopBackendBootstrap {
  return {
    mode: "desktop",
    noBrowser: true,
    port: input.port,
    t3Home: input.t3Home,
    host: input.host ?? "127.0.0.1",
    desktopBootstrapToken: input.bootstrapToken ?? UI_SMOKE_BOOTSTRAP_TOKEN,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
}

export function encodeDesktopBootstrapEnvelope(bootstrap: DesktopBackendBootstrap): string {
  return `${JSON.stringify(bootstrap)}\n`;
}

export function appendServerLogChunk(
  serverLog: string,
  chunk: Buffer | string,
): { readonly serverLog: string; readonly pairingToken: string | null } {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const nextLog = serverLog + text;
  return {
    serverLog: nextLog,
    pairingToken: parsePairingTokenFromLog(nextLog),
  };
}

export function parsePairingTokenFromLog(
  logText: string,
  pattern: RegExp = UI_SMOKE_PAIRING_TOKEN_PATTERN,
): string | null {
  const match = logText.match(pattern);
  if (match?.[1]) {
    return match[1];
  }

  const tokenLine = logText.match(/^Token: ([A-Z0-9]+)$/m);
  return tokenLine?.[1] ?? null;
}

export async function waitForValue<T>(
  readValue: () => T | null | undefined,
  options?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly errorMessage?: string;
    readonly abortIf?: () => Error | null | undefined;
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const intervalMs = options?.intervalMs ?? 250;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const abortError = options?.abortIf?.();
    if (abortError) {
      throw abortError;
    }

    const value = readValue();
    if (value !== null && value !== undefined) {
      return value;
    }
    await delay(intervalMs);
  }

  throw new Error(options?.errorMessage ?? "Timed out waiting for expected value.");
}

export function extractSessionCookie(
  setCookieHeader: string | ReadonlyArray<string> | null | undefined,
): { readonly name: string; readonly value: string } | null {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) {
    return null;
  }

  const pair = raw.split(";")[0]?.trim();
  if (!pair) {
    return null;
  }

  const separatorIndex = pair.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    name: pair.slice(0, separatorIndex),
    value: pair.slice(separatorIndex + 1),
  };
}

export async function waitForHttpOk(
  url: string,
  options?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const intervalMs = options?.intervalMs ?? 250;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchImpl(url, { redirect: "manual" });
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${url} to become ready.`);
}

export async function bootstrapBrowserSession(input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly name: string; readonly value: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  await waitForHttpOk(`${input.baseUrl}/`, { fetchImpl });
  const response = await fetchImpl(`${input.baseUrl}/api/auth/browser-session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      credential: input.credential,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Browser session bootstrap failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const setCookie = response.headers.getSetCookie?.() ?? response.headers.get("set-cookie");
  const cookie = extractSessionCookie(setCookie);
  if (!cookie) {
    throw new Error("Browser session bootstrap succeeded but no session cookie was returned.");
  }

  return cookie;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
