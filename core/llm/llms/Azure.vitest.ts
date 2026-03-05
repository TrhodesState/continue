import { describe, expect, it, vi } from "vitest";

import Azure from "./Azure.js";

describe("Azure core adapter routing", () => {
  it("routes streamChat through openai-adapter path", async () => {
    const llm = new Azure({
      apiKey: "test-api-key",
      model: "gpt-5.3-codex",
      apiBase: "https://example-resource.cognitiveservices.azure.com",
      env: {
        deployment: "gpt-5.3-codex",
        apiType: "azure-openai",
        apiVersion: "2025-04-01-preview",
      },
    } as any);

    const chatCompletionStream = vi.fn().mockImplementation(async function* () {
      yield {
        id: "chunk_1",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "gpt-5.3-codex",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "adapter stream ok",
            },
            finish_reason: null,
          },
        ],
      };
    });

    (llm as any).openaiAdapter = {
      chatCompletionStream,
    };

    const chunks = [];
    for await (const chunk of llm.streamChat(
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(chunks[0]).toMatchObject({
      role: "assistant",
      content: "adapter stream ok",
    });
  });
});
