import { EventId, MessageId, ProviderItemId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantMessageIdFromProviderItem,
  assistantSegmentBaseKeyFromEvent,
  assistantSegmentMessageId,
} from "./assistantSegmentMessageIds.ts";

const asEventId = (value: string) => EventId.make(value);
const asItemId = (value: string) => ProviderItemId.make(value);
const asTurnId = (value: string) => TurnId.make(value);

describe("assistantSegmentMessageIds", () => {
  it("scopes assistant base keys by turn id when available", () => {
    const event = {
      eventId: asEventId("evt-1"),
      itemId: asItemId("assistant:grok-session:segment:13"),
      turnId: asTurnId("turn-a"),
    };

    expect(assistantSegmentBaseKeyFromEvent(event, asTurnId("turn-a"))).toBe(
      "turn-a:assistant:grok-session:segment:13",
    );
    expect(assistantSegmentBaseKeyFromEvent(event, asTurnId("turn-b"))).toBe(
      "turn-b:assistant:grok-session:segment:13",
    );
  });

  it("builds distinct message ids for reused provider segments across turns", () => {
    const grokSegment = asItemId("assistant:grok-session:segment:13");
    const turnA = asTurnId("turn-a");
    const turnB = asTurnId("turn-b");

    const turnAMessageId = assistantMessageIdFromProviderItem(
      { eventId: asEventId("evt-a"), itemId: grokSegment, turnId: turnA },
      turnA,
    );
    const turnBMessageId = assistantMessageIdFromProviderItem(
      { eventId: asEventId("evt-b"), itemId: grokSegment, turnId: turnB },
      turnB,
    );

    expect(turnAMessageId).toBe(
      MessageId.make("assistant:turn-a:assistant:grok-session:segment:13"),
    );
    expect(turnBMessageId).toBe(
      MessageId.make("assistant:turn-b:assistant:grok-session:segment:13"),
    );
    expect(turnAMessageId).not.toBe(turnBMessageId);
  });

  it("keeps legacy ids when no turn id is available", () => {
    const event = {
      eventId: asEventId("evt-legacy"),
      itemId: asItemId("item-1"),
      turnId: undefined,
    };

    expect(assistantSegmentBaseKeyFromEvent(event)).toBe("item-1");
    expect(assistantSegmentMessageId("item-1", 0)).toBe(MessageId.make("assistant:item-1"));
    expect(assistantSegmentMessageId("item-1", 1)).toBe(
      MessageId.make("assistant:item-1:segment:1"),
    );
  });
});
