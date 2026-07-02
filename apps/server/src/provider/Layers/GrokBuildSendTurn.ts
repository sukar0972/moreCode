import {
  type ChatAttachment,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { applyAcpInteractionMode } from "../acp/AcpInteractionModeSupport.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  buildGrokBuildPromptBlocks,
  mapGrokSlugToAcpModelId,
  type GrokAcpPromptCapabilities,
} from "../acp/GrokAcpSupport.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

interface GrokBuildTurnRecord {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface GrokBuildSendTurnContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly promptCapabilities: GrokAcpPromptCapabilities;
  readonly turns: Array<GrokBuildTurnRecord>;
  activeTurnId: TurnId | undefined;
  readonly interruptedTurnIds: Set<TurnId>;
  readonly promptFibers: Set<Fiber.Fiber<void | undefined, ProviderAdapterError>>;
  lastPlanFingerprint: string | undefined;
  readonly currentModelId: string | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

type GrokBuildSendTurn = ProviderAdapterShape<ProviderAdapterError>["sendTurn"];
type RuntimeEventStamp = Pick<ProviderRuntimeEvent, "createdAt" | "eventId">;
type ThreadLock = <A, E, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

interface PreparedGrokBuildPrompt {
  readonly context: GrokBuildSendTurnContext;
  readonly promptBlocks: ReadonlyArray<EffectAcpSchema.ContentBlock>;
  readonly turnId: TurnId;
  readonly resumeCursor: unknown;
}

export function makeGrokBuildSendTurn(input: {
  readonly provider: ProviderDriverKind;
  readonly boundInstanceId: ProviderInstanceId;
  readonly withThreadLock: ThreadLock;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<GrokBuildSendTurnContext, ProviderAdapterSessionNotFoundError>;
  readonly resolveAttachmentBlock: (
    cwd: string,
    attachment: ChatAttachment,
    promptCapabilities: GrokAcpPromptCapabilities,
  ) => Effect.Effect<EffectAcpSchema.ContentBlock, ProviderAdapterRequestError>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterError>;
  readonly nowIso: Effect.Effect<string, ProviderAdapterError>;
  readonly makeEventStamp: () => Effect.Effect<RuntimeEventStamp, ProviderAdapterError>;
  readonly offerRuntimeEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProviderAdapterError>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, ProviderAdapterError>;
}): GrokBuildSendTurn {
  const releaseContextPrompt = (context: GrokBuildSendTurnContext) =>
    Effect.sync(() => {
      context.promptsInFlight = Math.max(0, context.promptsInFlight - 1);
    });
  const releasePrompt = (prepared: PreparedGrokBuildPrompt) =>
    Effect.sync(() => {
      if (prepared.context.interruptedTurnIds.has(prepared.turnId)) {
        return;
      }
      prepared.context.promptsInFlight = Math.max(0, prepared.context.promptsInFlight - 1);
    });

  const preparePrompt = (request: Parameters<GrokBuildSendTurn>[0]) =>
    input.withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        const context = yield* input.requireSession(request.threadId);
        const steeringTurnId = context.promptsInFlight > 0 ? context.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* input.randomUUIDv4);
        context.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            request.modelSelection?.instanceId === input.boundInstanceId
              ? request.modelSelection
              : undefined;
          const requestedModel = turnModelSelection?.model ?? context.session.model ?? "grok-build";
          if (mapGrokSlugToAcpModelId(requestedModel) !== context.currentModelId) {
            return yield* new ProviderAdapterValidationError({
              provider: input.provider,
              operation: "sendTurn",
              issue: "Start a new chat to change Grok Build models.",
            });
          }

          yield* applyAcpInteractionMode({
            runtime: context.acp,
            runtimeMode: context.session.runtimeMode,
            interactionMode: request.interactionMode,
            mapError: ({ cause }) =>
              mapAcpToAdapterError(input.provider, request.threadId, "session/set_mode", cause),
          });

          const attachments = request.attachments ?? [];
          const sessionCwd = context.session.cwd?.trim();
          if (attachments.length > 0 && !sessionCwd) {
            return yield* new ProviderAdapterValidationError({
              provider: input.provider,
              operation: "sendTurn",
              issue: "Attachments require a session cwd.",
            });
          }
          const attachmentBlocks = yield* Effect.forEach(
            attachments,
            (attachment) =>
              input.resolveAttachmentBlock(
                sessionCwd ?? "",
                attachment,
                context.promptCapabilities,
              ),
            { concurrency: 1 },
          );
          const promptBlocks = buildGrokBuildPromptBlocks({
            text: request.input,
            attachmentBlocks,
          });
          if (promptBlocks.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: input.provider,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          context.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            context.lastPlanFingerprint = undefined;
          }
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* input.nowIso,
            model: requestedModel,
          };
          if (steeringTurnId === undefined) {
            yield* input.offerRuntimeEvent({
              type: "turn.started",
              ...(yield* input.makeEventStamp()),
              provider: input.provider,
              threadId: request.threadId,
              turnId,
              payload: { model: requestedModel },
            });
          }

          return {
            context,
            promptBlocks,
            turnId,
            resumeCursor: context.session.resumeCursor,
          } satisfies PreparedGrokBuildPrompt;
        }).pipe(Effect.tapCause(() => releaseContextPrompt(context)));
      }),
    );

  const settleSuccess = (
    request: Parameters<GrokBuildSendTurn>[0],
    prepared: PreparedGrokBuildPrompt,
    result: EffectAcpSchema.PromptResponse,
  ) =>
    input.withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        const context = yield* input.requireSession(request.threadId);
        if (context !== prepared.context) {
          return yield* new ProviderAdapterRequestError({
            provider: input.provider,
            method: "session/prompt",
            detail: "Grok Build session changed before the turn completed.",
          });
        }
        if (context.interruptedTurnIds.has(prepared.turnId)) {
          context.interruptedTurnIds.delete(prepared.turnId);
          return;
        }

        const existingTurnRecord = context.turns.find((turn) => turn.id === prepared.turnId);
        const item = { prompt: prepared.promptBlocks, result };
        if (existingTurnRecord) {
          existingTurnRecord.items.push(item);
        } else {
          context.turns.push({ id: prepared.turnId, items: [item] });
        }
        if (context.promptsInFlight !== 1) {
          return;
        }

        context.activeTurnId = undefined;
        const { activeTurnId: _activeTurnId, lastError: _lastError, ...session } = context.session;
        context.session = {
          ...session,
          status: "ready",
          updatedAt: yield* input.nowIso,
        };
        yield* input.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* input.makeEventStamp()),
          provider: input.provider,
          threadId: request.threadId,
          turnId: prepared.turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });
      }),
    );

  const settleFailure = (
    request: Parameters<GrokBuildSendTurn>[0],
    prepared: PreparedGrokBuildPrompt,
  ) => {
    if (prepared.context.stopped) {
      return Effect.void;
    }
    const errorMessage = "Failed to send prompt to Grok Build CLI.";
    return input.withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        const context = yield* input.requireSession(request.threadId);
        if (context !== prepared.context) {
          return;
        }
        if (context.interruptedTurnIds.has(prepared.turnId)) {
          context.interruptedTurnIds.delete(prepared.turnId);
          return;
        }
        if (context.promptsInFlight === 1 && context.activeTurnId === prepared.turnId) {
          context.activeTurnId = undefined;
          const { activeTurnId: _activeTurnId, ...session } = context.session;
          context.session = {
            ...session,
            status: "error",
            updatedAt: yield* input.nowIso,
            lastError: errorMessage,
          };
          yield* input.offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* input.makeEventStamp()),
            provider: input.provider,
            threadId: request.threadId,
            turnId: prepared.turnId,
            payload: { state: "failed", errorMessage },
          });
        }
        yield* input.offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* input.makeEventStamp()),
          provider: input.provider,
          threadId: request.threadId,
          payload: {
            message: errorMessage,
            class: "provider_error",
            detail: { errorCode: "PromptFailed" },
          },
        });
      }),
    );
  };

  return (request) =>
    Effect.gen(function* () {
      const prepared = yield* preparePrompt(request);
      const payload: Omit<EffectAcpSchema.PromptRequest, "sessionId"> = {
        prompt: prepared.promptBlocks,
      };
      const context = yield* Effect.gen(function* () {
        yield* input.logNative(request.threadId, "session/prompt", payload);
        return yield* input.withThreadLock(
          request.threadId,
          Effect.gen(function* () {
            const current = yield* input.requireSession(request.threadId);
            if (current !== prepared.context) {
              return yield* new ProviderAdapterRequestError({
                provider: input.provider,
                method: "session/prompt",
                detail: "Grok Build session changed before the prompt was sent.",
              });
            }
            return current;
          }),
        );
      }).pipe(Effect.tapCause(() => releasePrompt(prepared)));

      const promptFiber = yield* input.withThreadLock(
        request.threadId,
        context.acp.prompt(payload).pipe(
          Effect.tap((result) =>
            input.logNative(request.threadId, "session/prompt(response)", result),
          ),
          Effect.flatMap((result) => settleSuccess(request, prepared, result)),
          Effect.catchCause(() => settleFailure(request, prepared)),
          Effect.ensuring(
            Effect.sync(() => {
              context.promptFibers.delete(promptFiber);
            }).pipe(Effect.andThen(releasePrompt(prepared))),
          ),
          Effect.forkIn(context.scope),
          Effect.tap((fiber) =>
            Effect.sync(() => {
              context.promptFibers.add(fiber);
            }),
          ),
        ),
      );

      return {
        threadId: request.threadId,
        turnId: prepared.turnId,
        resumeCursor: prepared.resumeCursor,
      };
    });
}
