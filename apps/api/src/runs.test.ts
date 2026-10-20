import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPreview } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toEqual({
      promptSnippet: "Maya asked: Please check the release workflow.",
      agentMessage: {
        fromBotName: "Maya",
        kind: "request",
        text: "Please check the release workflow.",
      },
    });
  });

  it.each(["result", "status", "fyi"])(
    "preserves the legacy %s update snippet alongside message text",
    (intent) => {
      expect(
        activityPreview({
          trigger: "bot_message",
          prompt: "internal",
          sourceBlocks: [
            {
              kind: "bot_message_received",
              fromBotId: "peer",
              fromBotName: "  ",
              intent,
              text: " first\n second ",
            },
          ],
        }),
      ).toEqual({
        promptSnippet: "Update from Another agent: first second",
        agentMessage: { fromBotName: "", kind: "update", text: "first second" },
      });
    },
  );

  it("preserves ordinary snippets and caps composed snippets and message text independently", () => {
    expect(activityPreview({ trigger: "user", prompt: " hello\n world " })).toEqual({
      promptSnippet: "hello world",
      agentMessage: null,
    });
    const preview = activityPreview({
      trigger: "bot_message",
      prompt: "internal",
      sourceBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "peer",
          fromBotName: "Peer",
          intent: "request",
          text: "x".repeat(130),
        },
      ],
    });
    expect(preview.promptSnippet).toBe(`Peer asked: ${"x".repeat(107)}…`);
    expect(preview.agentMessage?.text).toBe(`${"x".repeat(119)}…`);
  });

  it.each([
    ["request", "Maya", "Maya asked"],
    ["status", "Maya", "Update from Maya"],
    ["request", " ", "Another agent asked"],
  ])("preserves the legacy empty %s message label", (intent, fromBotName, label) => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "internal",
        sourceBlocks: [
          { kind: "bot_message_received", fromBotId: "peer", fromBotName, intent, text: " \n " },
        ],
      }),
    ).toEqual({
      promptSnippet: label,
      agentMessage: {
        fromBotName: fromBotName.trim(),
        kind: intent === "status" ? "update" : "request",
        text: "",
      },
    });
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toEqual({ promptSnippet: "Message from another agent", agentMessage: null });
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});
