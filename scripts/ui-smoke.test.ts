// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeDesktopBootstrapEnvelope,
  extractSessionCookie,
  makeUiSmokeBootstrap,
  parsePairingTokenFromLog,
  resolveUiSmokePort,
  UI_SMOKE_BOOTSTRAP_TOKEN,
  UI_SMOKE_DEFAULT_PORT,
} from "./lib/ui-smoke.ts";

describe("ui-smoke helpers", () => {
  it("resolves the default smoke port", () => {
    assert.equal(resolveUiSmokePort(undefined), UI_SMOKE_DEFAULT_PORT);
    assert.equal(resolveUiSmokePort("15000"), 15_000);
  });

  it("rejects invalid smoke ports", () => {
    assert.throws(() => resolveUiSmokePort("0"), /Invalid UI smoke port/);
    assert.throws(() => resolveUiSmokePort("70000"), /Invalid UI smoke port/);
  });

  it("extracts the first session cookie pair", () => {
    assert.deepEqual(extractSessionCookie("t3_session_abc=token-value; Path=/; HttpOnly"), {
      name: "t3_session_abc",
      value: "token-value",
    });
    assert.deepEqual(extractSessionCookie(["t3_session_xyz=another; Path=/", "ignored=1"]), {
      name: "t3_session_xyz",
      value: "another",
    });
    assert.equal(extractSessionCookie(undefined), null);
  });

  it("parses the startup pairing token from server logs", () => {
    assert.equal(
      parsePairingTokenFromLog("pairingUrl: http://localhost:5733/pair#token=ADDY6J8YYPCM\n"),
      "ADDY6J8YYPCM",
    );
    assert.equal(
      parsePairingTokenFromLog(
        "more Code server is ready.\nPairing URL: http://127.0.0.1:14773/pair#token=PAIRCODE\n",
      ),
      "PAIRCODE",
    );
    assert.equal(parsePairingTokenFromLog("Token: ADDY6J8YYPCM\n"), "ADDY6J8YYPCM");
    assert.equal(parsePairingTokenFromLog("no token here"), null);
  });

  it("encodes a desktop bootstrap envelope", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "morecode-ui-smoke-test-"));
    try {
      const envelope = makeUiSmokeBootstrap({
        port: UI_SMOKE_DEFAULT_PORT,
        t3Home: join(tempRoot, "home"),
      });
      const encoded = encodeDesktopBootstrapEnvelope(envelope);
      const parsed = JSON.parse(encoded.trim()) as {
        readonly desktopBootstrapToken: string;
        readonly mode: string;
        readonly port: number;
      };

      assert.equal(parsed.mode, "desktop");
      assert.equal(parsed.port, UI_SMOKE_DEFAULT_PORT);
      assert.equal(parsed.desktopBootstrapToken, UI_SMOKE_BOOTSTRAP_TOKEN);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
