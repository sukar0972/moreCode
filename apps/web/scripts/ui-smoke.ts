#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import {
  appendServerLogChunk,
  assertUiSmokeBuildAssets,
  bootstrapBrowserSession,
  resolveAvailableTcpPort,
  resolveUiSmokeBuildPaths,
  resolveUiSmokePort,
  UI_SMOKE_READY_TEXT,
  UI_SMOKE_ROOT_ERROR_TEXT,
  UI_SMOKE_WS_ERROR_TEXT,
  waitForValue,
} from "../../../scripts/lib/ui-smoke.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: args } = parseArgs({
  options: {
    port: { type: "string" },
    "skip-build-check": { type: "boolean", default: false },
  },
});

const preferredSmokePort = resolveUiSmokePort(args.port ?? process.env.UI_SMOKE_PORT);
const smokeHost = "localhost";
const serverShutdownTimeoutMs = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function stopServerProcess(serverProcess: ChildProcess | undefined): Promise<void> {
  if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) {
    return;
  }

  const exitPromise = new Promise<void>((resolveExit) => {
    serverProcess.once("exit", () => resolveExit());
  });

  serverProcess.kill("SIGTERM");
  await Promise.race([
    exitPromise,
    delay(serverShutdownTimeoutMs).then(() => {
      if (serverProcess.exitCode === null && !serverProcess.killed) {
        serverProcess.kill("SIGKILL");
      }
    }),
  ]);
  await exitPromise.catch(() => undefined);
}

async function runUiSmoke(): Promise<void> {
  if (!args["skip-build-check"]) {
    assertUiSmokeBuildAssets(resolveUiSmokeBuildPaths(repoRoot));
  }

  const smokePort = await resolveAvailableTcpPort(smokeHost, preferredSmokePort);
  const baseUrl = `http://${smokeHost}:${smokePort}`;
  const buildPaths = resolveUiSmokeBuildPaths(repoRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), "morecode-ui-smoke-"));
  const t3Home = join(tempRoot, "home");
  let pairingToken: string | undefined;
  let serverLog = "";
  let serverExitError: Error | undefined;
  let serverProcess: ChildProcess | undefined;

  try {
    const serverEnv = { ...process.env };
    delete serverEnv.MORECODE_T3CODE_PORT;
    delete serverEnv.PORT;
    delete serverEnv.VITE_DEV_SERVER_URL;
    delete serverEnv.VITE_WS_URL;

    serverProcess = spawn(
      process.execPath,
      [
        buildPaths.serverBin,
        "serve",
        "--port",
        String(smokePort),
        "--host",
        "127.0.0.1",
        "--base-dir",
        t3Home,
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: serverEnv,
      },
    );

    const handleServerOutput = (chunk: Buffer | string) => {
      const next = appendServerLogChunk(serverLog, chunk);
      serverLog = next.serverLog;
      pairingToken = next.pairingToken ?? pairingToken;
    };

    serverProcess.stderr?.on("data", (chunk: Buffer | string) => {
      process.stderr.write(chunk);
      handleServerOutput(chunk);
    });
    serverProcess.stdout?.on("data", (chunk: Buffer | string) => {
      process.stdout.write(chunk);
      handleServerOutput(chunk);
    });

    serverProcess.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        serverExitError = new Error(
          `UI smoke server exited early (code=${code}, signal=${signal ?? "none"}).`,
        );
      }
    });

    const startupPairingToken = await waitForValue(() => pairingToken, {
      errorMessage: "Timed out waiting for the server startup pairing token.",
      abortIf: () => serverExitError,
    });

    const sessionCookie = await bootstrapBrowserSession({
      baseUrl,
      credential: startupPairingToken,
    });

    const pageErrors: Array<string> = [];
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext({ baseURL: baseUrl });
      await context.addCookies([
        {
          name: sessionCookie.name,
          value: sessionCookie.value,
          domain: smokeHost,
          path: "/",
        },
      ]);

      const page = await context.newPage();
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });

      await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });

      try {
        await page
          .getByText(UI_SMOKE_READY_TEXT)
          .or(page.getByText("No active thread"))
          .first()
          .waitFor({
            state: "visible",
            timeout: 60_000,
          });
      } catch (cause) {
        const bodyText = await page
          .locator("body")
          .innerText()
          .catch(() => "<unable to read page text>");
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `${message}\nExpected to find "${UI_SMOKE_READY_TEXT}" in the web UI. Page text:\n${bodyText}`,
          { cause: cause },
        );
      }

      await delay(1_000);

      if ((await page.getByText(UI_SMOKE_ROOT_ERROR_TEXT).count()) > 0) {
        throw new Error(`Web UI rendered the root error view: "${UI_SMOKE_ROOT_ERROR_TEXT}"`);
      }

      if ((await page.getByText(UI_SMOKE_WS_ERROR_TEXT).count()) > 0) {
        throw new Error(
          `Web UI reported a websocket connection failure: "${UI_SMOKE_WS_ERROR_TEXT}"`,
        );
      }

      if (pageErrors.length > 0) {
        throw new Error(`Web UI emitted uncaught page errors:\n- ${pageErrors.join("\n- ")}`);
      }

      console.log("UI smoke checks passed.");
    } finally {
      await browser.close().catch(() => undefined);
    }
  } finally {
    await stopServerProcess(serverProcess);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

runUiSmoke().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.log(`UI smoke failed: ${message}`);
  process.exitCode = 1;
});