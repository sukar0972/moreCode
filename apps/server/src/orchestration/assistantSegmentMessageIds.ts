import { MessageId, TurnId, type ProviderRuntimeEvent } from "@t3tools/contracts";

type ProviderAssistantIdentityEvent = Pick<ProviderRuntimeEvent, "itemId" | "turnId" | "eventId">;

function resolveTurnId(
  turnId: TurnId | undefined,
  eventTurnId: TurnId | string | undefined,
): TurnId | undefined {
  if (turnId !== undefined) {
    return turnId;
  }
  if (eventTurnId === undefined) {
    return undefined;
  }
  return TurnId.make(String(eventTurnId));
}

/**
 * Stable provider-side identity for an assistant segment. When a turn id is
 * known, include it so reused ACP/Grok session segment ids do not collide
 * across turns in the same thread.
 */
export function assistantSegmentBaseKeyFromEvent(
  event: ProviderAssistantIdentityEvent,
  turnId?: TurnId,
): string {
  const providerKey = String(event.itemId ?? event.turnId ?? event.eventId);
  const resolvedTurnId = resolveTurnId(turnId, event.turnId);
  return resolvedTurnId ? `${resolvedTurnId}:${providerKey}` : providerKey;
}

export function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}

export function assistantMessageIdFromProviderItem(
  event: ProviderAssistantIdentityEvent,
  turnId?: TurnId,
): MessageId {
  return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(event, turnId), 0);
}
