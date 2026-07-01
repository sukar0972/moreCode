import { type GrokBuildSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import { parseXAiPromptCompleteResponse } from "./XAiAcpExtension.ts";

export const GROK_BUILD_RESUME_VERSION = 1;

export const GROK_BUILD_EMBEDDED_FILE_MAX_BYTES = 64 * 1024;

export interface GrokAcpPromptCapabilities {
  readonly audio: boolean;
  readonly embeddedContext: boolean;
  readonly image: boolean;
}

export interface GrokAcpAvailableModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string;
}

export interface GrokAcpProbeResult {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseGrokBuildResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_BUILD_RESUME_VERSION) return undefined;
  const sessionId = readString(raw.sessionId);
  return sessionId ? { sessionId } : undefined;
}

export function parseEnvJson(json: string): Record<string, string> {
  if (!json || !json.trim()) return {};
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('Environment overrides must be a JSON object, e.g. {"XAI_LOG_LEVEL":"debug"}');
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      result[k] = String(v);
    } else {
      throw new Error(
        `Environment override for key '${k}' has invalid type. Expected string, number, or boolean.`,
      );
    }
  }
  return result;
}

export function buildGrokCliProcessEnv(
  environment: NodeJS.ProcessEnv = {},
  envOverrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...process.env, ...environment, ...envOverrides };
}

export function buildGrokBuildAcpSpawnInput(
  settings: Pick<GrokBuildSettings, "command" | "args" | "envJson">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  envOverrides: Record<string, string> = parseEnvJson(settings.envJson),
): AcpSpawnInput {
  return {
    command: settings.command || "grok",
    args: settings.args?.length ? settings.args : ["agent", "stdio"],
    cwd,
    env: buildGrokCliProcessEnv(environment, envOverrides),
  };
}

export interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: Pick<GrokBuildSettings, "command" | "args" | "envJson">;
  readonly environment?: NodeJS.ProcessEnv;
  readonly envOverrides?: Record<string, string> | undefined;
}

export const makeGrokBuildAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokBuildAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.envOverrides,
        ),
        authMethodId: "cached_token",
        setModelStrategy: "sessionSetModel",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
    const activeSessionIdRef = yield* Ref.make<string | undefined>(undefined);
    const promptCompleteWaitersRef = yield* Ref.make(
      new Map<string, ReadonlyArray<Deferred.Deferred<EffectAcpSchema.PromptResponse>>>(),
    );
    const notificationResolvedWaitersRef = yield* Ref.make(
      new Set<Deferred.Deferred<EffectAcpSchema.PromptResponse>>(),
    );

    yield* runtime.handleUnknownExtNotification((method, payload) => {
      if (method !== "_x.ai/session/prompt_complete" && method !== "x.ai/session/prompt_complete") {
        return Effect.void;
      }
      const completed = parseXAiPromptCompleteResponse(payload);
      if (!completed) {
        return Effect.void;
      }
      return Ref.modify(promptCompleteWaitersRef, (waiters) => {
        const sessionWaiters = waiters.get(completed.sessionId) ?? [];
        const [waiter, ...remainingWaiters] = sessionWaiters;
        if (!waiter) {
          return [Effect.void, waiters] as const;
        }
        const next = new Map(waiters);
        if (remainingWaiters.length > 0) {
          next.set(completed.sessionId, remainingWaiters);
        } else {
          next.delete(completed.sessionId);
        }
        return [
          Deferred.succeed(waiter, completed.response).pipe(
            Effect.tap(() =>
              Ref.update(notificationResolvedWaitersRef, (resolved) => new Set([...resolved, waiter])),
            ),
            Effect.asVoid,
          ),
          next,
        ] as const;
      }).pipe(Effect.flatten);
    });

    const start: AcpSessionRuntimeShape["start"] = () =>
      runtime.start().pipe(Effect.tap((started) => Ref.set(activeSessionIdRef, started.sessionId)));

    const settlePromptCompleteWaitersAsCancelled = Ref.modify(
      promptCompleteWaitersRef,
      (waiters) => [
        Effect.forEach(
          Array.from(waiters.values()).flat(),
          (waiter) =>
            Deferred.succeed(waiter, {
              stopReason: "cancelled",
            } satisfies EffectAcpSchema.PromptResponse),
          { discard: true },
        ),
        new Map<string, ReadonlyArray<Deferred.Deferred<EffectAcpSchema.PromptResponse>>>(),
      ],
    ).pipe(Effect.flatten);

    const prompt: AcpSessionRuntimeShape["prompt"] = (payload) =>
      Effect.gen(function* () {
        const sessionId = yield* Ref.get(activeSessionIdRef);
        if (!sessionId) {
          return yield* runtime.prompt(payload);
        }
        const waiter = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        // xAI prompt_complete notifications carry no turn id; waiters are FIFO per session.
        yield* Ref.update(promptCompleteWaitersRef, (waiters) => {
          const next = new Map(waiters);
          next.set(sessionId, [...(next.get(sessionId) ?? []), waiter]);
          return next;
        });
        return yield* Effect.raceFirst(runtime.prompt(payload), Deferred.await(waiter)).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const completedViaNotification = (yield* Ref.get(notificationResolvedWaitersRef)).has(
                waiter,
              );
              if (completedViaNotification) {
                yield* Ref.update(notificationResolvedWaitersRef, (resolved) => {
                  const next = new Set(resolved);
                  next.delete(waiter);
                  return next;
                });
                yield* runtime.cancel().pipe(Effect.ignore);
              }
              yield* Ref.update(promptCompleteWaitersRef, (waiters) => {
                const sessionWaiters = waiters.get(sessionId);
                if (!sessionWaiters?.includes(waiter)) {
                  return waiters;
                }
                const remainingWaiters = sessionWaiters.filter((candidate) => candidate !== waiter);
                const next = new Map(waiters);
                if (remainingWaiters.length > 0) {
                  next.set(sessionId, remainingWaiters);
                } else {
                  next.delete(sessionId);
                }
                return next;
              });
            }),
          ),
        );
      });

    const cancel: AcpSessionRuntimeShape["cancel"] = settlePromptCompleteWaitersAsCancelled.pipe(
      Effect.andThen(runtime.cancel),
    );

    return {
      ...runtime,
      start,
      prompt,
      cancel,
    } satisfies AcpSessionRuntimeShape;
  });

export function extractGrokAcpPromptCapabilities(
  initializeResult: EffectAcpSchema.InitializeResponse,
): GrokAcpPromptCapabilities {
  const promptCapabilities = initializeResult.agentCapabilities?.promptCapabilities;
  return {
    audio: promptCapabilities?.audio ?? false,
    embeddedContext: promptCapabilities?.embeddedContext ?? false,
    image: promptCapabilities?.image ?? false,
  };
}

function readAvailableModelsFromRecord(
  record: Record<string, unknown>,
): ReadonlyArray<GrokAcpAvailableModel> {
  const modelState = record.modelState;
  if (isRecord(modelState) && Array.isArray(modelState.availableModels)) {
    return parseGrokAcpAvailableModels(modelState.availableModels);
  }
  const models = record.models;
  if (isRecord(models) && Array.isArray(models.availableModels)) {
    return parseGrokAcpAvailableModels(models.availableModels);
  }
  if (Array.isArray(models)) {
    return parseGrokAcpAvailableModels(models);
  }
  return [];
}

export function parseGrokAcpAvailableModels(value: unknown): ReadonlyArray<GrokAcpAvailableModel> {
  if (!Array.isArray(value)) {
    return [];
  }
  const models: GrokAcpAvailableModel[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const modelId = readString(entry.modelId) ?? readString(entry.id);
    const name = readString(entry.name) ?? modelId;
    if (!modelId || !name) continue;
    const description = readString(entry.description);
    models.push(description ? { modelId, name, description } : { modelId, name });
  }
  return models;
}

export function extractGrokAcpAvailableModels(input: {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
}): ReadonlyArray<GrokAcpAvailableModel> {
  const initializeMeta = input.initializeResult._meta;
  const fromInitialize = isRecord(initializeMeta)
    ? readAvailableModelsFromRecord(initializeMeta)
    : [];
  const sessionMeta = input.sessionSetupResult;
  const fromSession = isRecord(sessionMeta) ? readAvailableModelsFromRecord(sessionMeta) : [];
  const merged = new Map<string, GrokAcpAvailableModel>();
  for (const model of [...fromInitialize, ...fromSession]) {
    merged.set(model.modelId, model);
  }
  return Array.from(merged.values());
}

export function mapGrokAcpModelIdToSlug(modelId: string): string {
  if (modelId === "grok-composer-2.5-fast") {
    return "composer-2.5";
  }
  return modelId;
}

export function buildGrokBuildPromptBlocks(input: {
  readonly text: string | undefined;
  readonly attachmentBlocks: ReadonlyArray<EffectAcpSchema.ContentBlock>;
}): ReadonlyArray<EffectAcpSchema.ContentBlock> {
  const prompt: EffectAcpSchema.ContentBlock[] = [];
  const text = input.text?.trim();
  if (text) {
    prompt.push({ type: "text", text });
  }
  prompt.push(...input.attachmentBlocks);
  return prompt;
}

export function mapGrokSlugToAcpModelId(model: string | undefined): string {
  if (!model) {
    return "grok-build";
  }
  if (model === "composer-2.5" || model === "grok-composer-2.5-fast") {
    return "grok-composer-2.5-fast";
  }
  return model;
}

export function applyGrokBuildModelSelection<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly model: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (!input.model) return;
    yield* input.runtime
      .setModel(mapGrokSlugToAcpModelId(input.model))
      .pipe(Effect.mapError(input.mapError));
  });
}

const makeGrokAcpProbeRuntime = (
  settings: Pick<GrokBuildSettings, "command" | "args" | "envJson">,
  environment: NodeJS.ProcessEnv = process.env,
  envOverrides?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeGrokBuildAcpRuntime({
      grokSettings: settings,
      environment,
      ...(envOverrides ? { envOverrides } : {}),
      childProcessSpawner: spawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
  });

export const withGrokAcpProbeRuntime = <A, E, R>(
  settings: Pick<GrokBuildSettings, "command" | "args" | "envJson">,
  useRuntime: (acp: AcpSessionRuntimeShape) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv = process.env,
  envOverrides?: Record<string, string>,
) =>
  makeGrokAcpProbeRuntime(settings, environment, envOverrides).pipe(
    Effect.flatMap(useRuntime),
    Effect.scoped,
  );

export const probeGrokBuildViaAcp = (
  settings: Pick<GrokBuildSettings, "command" | "args" | "envJson">,
  environment: NodeJS.ProcessEnv = process.env,
  envOverrides?: Record<string, string>,
) =>
  withGrokAcpProbeRuntime(
    settings,
    (acp) =>
      Effect.gen(function* () {
        const started = yield* acp.start();
        return {
          initializeResult: started.initializeResult,
          sessionSetupResult: started.sessionSetupResult,
          configOptions: yield* acp.getConfigOptions,
          sessionId: started.sessionId,
        } satisfies GrokAcpProbeResult;
      }),
    environment,
    envOverrides,
  );
