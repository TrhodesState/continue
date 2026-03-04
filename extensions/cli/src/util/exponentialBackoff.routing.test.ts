import type { BaseLlmApi } from "@continuedev/openai-adapters";
import { describe, expect, it, vi } from "vitest";

import { chatCompletionStreamWithBackoff } from "./exponentialBackoff.js";

describe("chatCompletionStreamWithBackoff dialect routing", () => {
  it("retries and uses responsesStream for codex responses models", async () => {
    let attempt = 0;
    const responsesStream = vi.fn().mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) {
        const err: any = new Error("Service unavailable");
        err.status = 503;
        throw err;
      }

      return (async function* () {
        yield {
          id: "resp_codex_retry",
          object: "chat.completion.chunk",
          created: Date.now(),
          model: "codex-5.3",
          choices: [
            {
              index: 0,
              delta: { content: "retry succeeded" },
              finish_reason: null,
            },
          ],
        };
      })();
    });

    const chatCompletionStream = vi.fn().mockImplementation(async function* () {
      throw new Error("chatCompletionStream should not be called");
    });

    const llmApi = {
      apiBase: "https://api.openai.com/v1/",
      responsesStream,
      chatCompletionStream,
    } as unknown as BaseLlmApi;

    const stream = await chatCompletionStreamWithBackoff(
      llmApi,
      {
        model: "codex-5.3",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      } as any,
      new AbortController().signal,
      {
        maxRetries: 1,
        initialDelay: 0,
        maxDelay: 0,
        backoffMultiplier: 1,
        jitter: false,
        hiddenRetries: 0,
      },
    );

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(responsesStream).toHaveBeenCalledTimes(2);
    expect(chatCompletionStream).not.toHaveBeenCalled();
    expect(chunks[0]?.choices?.[0]?.delta?.content).toBe("retry succeeded");
  });

  it("uses chatCompletionStream for anthropic messages dialect models", async () => {
    const responsesStream = vi.fn().mockImplementation(async function* () {
      throw new Error("responsesStream should not be called");
    });

    const chatCompletionStream = vi.fn().mockImplementation(async function* () {
      yield {
        id: "resp_opus_chat",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "claude-opus-4-6",
        choices: [
          {
            index: 0,
            delta: { content: "using anthropic messages path" },
            finish_reason: null,
          },
        ],
      };
    });

    const llmApi = {
      apiBase: "https://api.openai.com/v1/",
      responsesStream,
      chatCompletionStream,
    } as unknown as BaseLlmApi;

    const stream = await chatCompletionStreamWithBackoff(
      llmApi,
      {
        model: "claude-opus-4-6",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      } as any,
      new AbortController().signal,
    );

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(responsesStream).not.toHaveBeenCalled();
    expect(chunks[0]?.choices?.[0]?.delta?.content).toContain("anthropic");
  });
});
