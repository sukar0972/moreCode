// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ApprovalRequestId,
  GrokBuildSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  buildGrokBuildPromptBlocks,
  makeGrokBuildAdapter,
  resolveGrokBuildAcpBaseModelId,
} from "./GrokBuildAdapter.ts";

const decodeGrokBuildSettings = Schema.decodeSync(GrokBuildSettings);

class GrokBuildAdapter extends Context.Service<
  GrokBuildAdapter,
  ProviderAdapterShape<ProviderAdapterError>
>()("t3/provider/Layers/GrokBuildAdapter.test/GrokBuildAdapter") {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await Effect.runPromise(Effect.yieldNow);
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

describe("GrokBuildAdapter helpers", () => {
  it("maps user-facing model aliases to Grok ACP model ids", () => {
    expect(resolveGrokBuildAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokBuildAcpBaseModelId("composer-2.5")).toBe("grok-composer-2.5-fast");
    expect(resolveGrokBuildAcpBaseModelId("custom-model")).toBe("custom-model");
  });

  it("builds ACP prompt blocks from optional text and attachments", () => {
    const imageBlock = {
      type: "image",
      data: "base64-image",
      mimeType: "image/png",
    } satisfies EffectAcpSchema.ContentBlock;

    expect(
      buildGrokBuildPromptBlocks({
        text: "  inspect this  ",
        attachmentBlocks: [imageBlock],
      }),
    ).toEqual([{ type: "text", text: "inspect this" }, imageBlock]);

    expect(
      buildGrokBuildPromptBlocks({
        text: "   ",
        attachmentBlocks: [imageBlock],
      }),
    ).toEqual([imageBlock]);

    expect(
      buildGrokBuildPromptBlocks({
        text: undefined,
        attachmentBlocks: [],
      }),
    ).toEqual([]);
  });
});

const grokAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokAdapterTestLayer("GrokBuildAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-mock-thread");

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      assert.equal(session.provider, "grok-build");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ReadonlyArray<ProviderRuntimeEvent>;
      const types = runtimeEvents.map((event) => event.type);

      for (const expectedType of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, expectedType);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a session when a resume cursor is provided", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-resume-thread");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "resume check",
        attachments: [],
      });
      assert.deepStrictEqual(turn.resumeCursor, session.resumeCursor);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves the canonical model slug in session state", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-canonical-model-thread");
      const turnCompleted = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "composer-2.5",
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "keep the canonical model slug",
        attachments: [],
      });
      yield* Fiber.join(turnCompleted);

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.model, "composer-2.5");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("requires a new chat to change models", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-model-change-thread");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "grok-build",
        },
      });

      assert.equal(adapter.capabilities.sessionModelSwitch, "new-thread");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "switch models",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("grok-build-test"),
            model: "composer-2.5",
          },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        return;
      }
      assert.equal(error.issue, "Start a new chat to change Grok Build models.");

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokPromptFailureAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-prompt-failure-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokPromptFailureAdapterTestLayer("GrokBuildAdapter prompt failures", (it) => {
  it.effect("closes a failed turn before reporting the runtime error", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-prompt-failure-thread");
      const failureEvents = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.completed" || event.type === "runtime.error"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "fail this prompt",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(failureEvents));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["turn.completed", "runtime.error"],
      );
      const completed = events[0];
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.turnId, turn.turnId);
        assert.equal(completed.payload.state, "failed");
      }

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "error");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokPermissionAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_TOOL_CALLS_ON_PERMISSION_PHRASE: "1",
        }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-permission-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokPermissionAdapterTestLayer("GrokBuildAdapter permissions", (it) => {
  it.effect("handles permission requests and cancellation", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-permission-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const requestOpenedFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turnCompletedFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "trigger permission",
        attachments: [],
      });

      const openedEvents = Array.from(yield* Fiber.join(requestOpenedFiber));
      const opened = openedEvents[0];
      assert.isDefined(opened);

      yield* adapter.interruptTurn(threadId, turn.turnId);

      const completedEvents = Array.from(yield* Fiber.join(turnCompletedFiber));
      const completed = completedEvents[0];
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.turnId, turn.turnId);
        assert.equal(completed.payload.state, "cancelled");
        assert.equal(completed.payload.stopReason, "cancelled");
      }

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes a later turn after interrupting a blocked permission turn", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-permission-interrupt-next-turn-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const requestOpenedFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      const completedFiber = yield* Stream.take(adapter.streamEvents, 40).pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const interruptedTurn = yield* adapter.sendTurn({
        threadId,
        input: "trigger permission",
        attachments: [],
      });

      yield* Fiber.join(requestOpenedFiber);
      yield* adapter.interruptTurn(threadId, interruptedTurn.turnId);

      const nextTurn = yield* adapter.sendTurn({
        threadId,
        input: "plain follow-up after interrupt",
        attachments: [],
      });

      const completedEvents = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completedEvents.length, 2);
      const [cancelled, completed] = completedEvents;
      assert.equal(cancelled?.type, "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (cancelled?.type === "turn.completed") {
        assert.equal(cancelled.turnId, interruptedTurn.turnId);
        assert.equal(cancelled.payload.state, "cancelled");
      }
      if (completed?.type === "turn.completed") {
        assert.equal(completed.turnId, nextTurn.turnId);
        assert.equal(completed.payload.state, "completed");
        assert.equal(completed.payload.stopReason, "end_turn");
      }

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokPromptCompleteAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_HANG_PROMPT_WITH_XAI_COMPLETE: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-prompt-complete-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokPromptCompleteAdapterTestLayer("GrokBuildAdapter xAI prompt completion", (it) => {
  it.effect("settles a turn from prompt_complete when session/prompt remains pending", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-prompt-complete-thread");
      const turnCompletedFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "complete through xai notification",
        attachments: [],
      });

      const completedEvents = Array.from(yield* Fiber.join(turnCompletedFiber));
      const completed = completedEvents[0];
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.turnId, turn.turnId);
        assert.equal(completed.payload.state, "completed");
        assert.equal(completed.payload.stopReason, "end_turn");
      }

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokStopTestState: { exitLogPath?: string } = {};

const grokStopAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "grok-adapter-exit-log-")),
      );
      grokStopTestState.exitLogPath = path.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_LOG_PATH: grokStopTestState.exitLogPath! }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-stop-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const grokThreadAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-thread-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokThreadAdapterTestLayer("GrokBuildAdapter thread snapshot", (it) => {
  it.effect("records turns for readThread and rollbackThread", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-thread-snapshot");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const forkTurnCompletedWaiter = (count: number) =>
        Stream.take(adapter.streamEvents, 30).pipe(
          Stream.filter(
            (event) =>
              event.type === "turn.completed" && String(event.threadId) === String(threadId),
          ),
          Stream.take(count),
          Stream.runDrain,
          Effect.forkChild,
        );

      const firstTurnCompleted = yield* forkTurnCompletedWaiter(1);
      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Fiber.join(firstTurnCompleted);

      const secondTurnCompleted = yield* forkTurnCompletedWaiter(1);
      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      yield* Fiber.join(secondTurnCompleted);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 2);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, 1);
      assert.equal((yield* adapter.readThread(threadId)).turns.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokUserInputAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-user-input-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokUserInputAdapterTestLayer("GrokBuildAdapter user input", (it) => {
  it.effect("handles ask-question requests and user responses", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-user-input-thread");
      const userInputRequested = yield* Deferred.make<ApprovalRequestId>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        if (!event.requestId) {
          return Effect.void;
        }
        return Deferred.succeed(
          userInputRequested,
          ApprovalRequestId.make(String(event.requestId)),
        ).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestId = yield* Deferred.await(userInputRequested);
      yield* adapter.respondToUserInput(threadId, requestId, { scope: "workspace" });

      yield* Fiber.await(sendTurnFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" }),
      );
      const xaiAdapter = yield* makeGrokBuildAdapter(
        decodeGrokBuildSettings({
          enabled: true,
          command: wrapperPath,
          args: [],
          envJson: "{}",
          customModels: [],
        }),
        { instanceId: ProviderInstanceId.make("grok-build-test") },
      );
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(xaiAdapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* xaiAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "grok-build",
        },
      });

      const sendTurnFiber = yield* xaiAdapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      expect(requestedEvent.payload.questions.length).toBe(1);
      expect(requestedEvent.payload.questions[0]?.id).toBe("Which scope should Grok use?");
      expect(requestedEvent.payload.questions[0]?.question).toBe("Which scope should Grok use?");
      expect(requestedEvent.raw?.method).toBe("_x.ai/ask_user_question");

      yield* xaiAdapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      expect(resolvedEvent.payload.answers).toEqual({
        "Which scope should Grok use?": "Workspace",
      });
      yield* Fiber.await(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* xaiAdapter.stopSession(threadId);
    }),
  );
});

const grokPlanAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_CREATE_PLAN: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-plan-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokPlanAdapterTestLayer("GrokBuildAdapter plan flow", (it) => {
  it.effect("accepts create_plan extension requests during planning", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-create-plan-thread");

      const proposedPlanFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.proposed.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "draft a plan",
        attachments: [],
        interactionMode: "plan",
      });

      const proposedEvents = Array.from(yield* Fiber.join(proposedPlanFiber));
      assert.equal(proposedEvents.length, 1);
      const proposed = proposedEvents[0];
      assert.isDefined(proposed);
      if (proposed?.type === "turn.proposed.completed") {
        assert.include(proposed.payload.planMarkdown, "Mock plan");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokTodoAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_UPDATE_TODOS: "1" }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-todo-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokTodoAdapterTestLayer("GrokBuildAdapter todo updates", (it) => {
  it.effect("maps update_todos notifications into plan updates during implementation", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-update-todos-thread");

      const planUpdateFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.plan.updated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "implement todos",
        attachments: [],
        interactionMode: "default",
      });

      const planEvents = Array.from(yield* Fiber.join(planUpdateFiber));
      assert.equal(planEvents.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );
});

const grokModeAdapterTestLayer = it.layer(
  Layer.effect(
    GrokBuildAdapter,
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "grok-adapter-mode-log-")),
      );
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const settings = decodeGrokBuildSettings({
        enabled: true,
        command: wrapperPath,
        args: [],
        envJson: "{}",
        customModels: [],
      });
      return yield* makeGrokBuildAdapter(settings, {
        instanceId: ProviderInstanceId.make("grok-build-test"),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-grok-mode-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokModeAdapterTestLayer("GrokBuildAdapter interaction modes", (it) => {
  it.effect("switches to implementation mode when interactionMode is default", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-mode-switch-thread");
      const turnCompletedFiber = yield* Stream.take(adapter.streamEvents, 20).pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok-build-test"),
          model: "default",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "implement the plan",
        attachments: [],
        interactionMode: "default",
      });

      yield* Fiber.join(turnCompletedFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});

grokStopAdapterTestLayer("GrokBuildAdapter shutdown", (it) => {
  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokBuildAdapter;
      const threadId = ThreadId.make("grok-stop-session-close");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok-build"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      assert.isDefined(grokStopTestState.exitLogPath);
      const exitLog = yield* Effect.promise(() =>
        waitForFileContent(grokStopTestState.exitLogPath!),
      );
      assert.include(exitLog, "SIGTERM");
    }),
  );
});
