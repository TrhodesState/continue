import { describe, expect, it } from "vitest";

import { INITIAL_SESSION_STATE, sessionSlice } from "./sessionSlice";

describe("sessionSlice responses item ID metadata", () => {
  it("stores function_call item ids separately from message item ids", () => {
    const initialState = {
      ...INITIAL_SESSION_STATE,
      history: [
        {
          message: {
            id: "user_1",
            role: "user" as const,
            content: "Inspect these files",
          },
          contextItems: [],
        },
      ],
    };

    const action = {
      type: "session/streamUpdate",
      payload: [
        {
          role: "assistant" as const,
          content: "",
          metadata: { responsesOutputItemId: "msg_100" },
        },
        {
          role: "assistant" as const,
          content: "",
          metadata: { responsesOutputItemId: "fc_200" },
        },
        {
          role: "assistant" as const,
          content: "",
          metadata: { responsesOutputItemId: "fc_201" },
        },
      ],
    };

    const nextState = sessionSlice.reducer(initialState, action);
    const assistant = nextState.history[nextState.history.length - 1]
      .message as any;

    expect(assistant.metadata.responsesMessageItemIds).toEqual(["msg_100"]);
    expect(assistant.metadata.responsesFunctionCallItemIds).toEqual([
      "fc_200",
      "fc_201",
    ]);
    expect(assistant.metadata.responsesOutputItemIds).toEqual([
      "fc_200",
      "fc_201",
    ]);
  });
});
