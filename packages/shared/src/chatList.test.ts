import { describe, expect, it } from "vite-plus/test";

import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchorPosition } from "./chatList.ts";

describe("resolveChatListAnchorPosition", () => {
  it("returns undefined when no anchor is requested", () => {
    expect(resolveChatListAnchorPosition([{ id: "a" }], null, (item) => item.id)).toBeUndefined();
  });

  it("finds the last matching anchor item", () => {
    expect(
      resolveChatListAnchorPosition(
        [{ id: "sent" }, { id: "assistant" }, { id: "sent" }],
        "sent",
        (item) => item.id,
      ),
    ).toEqual({
      anchorIndex: 2,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
  });

  it("uses a custom anchor offset", () => {
    expect(
      resolveChatListAnchorPosition([{ id: "sent" }], "sent", (item) => item.id, {
        anchorOffset: 24,
      }),
    ).toEqual({
      anchorIndex: 0,
      anchorOffset: 24,
    });
  });
});
