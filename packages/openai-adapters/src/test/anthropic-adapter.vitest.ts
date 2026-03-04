import { afterEach, describe, expect, test, vi } from "vitest";
import { runAdapterTest } from "./adapter-test-utils.js";

// Mock the fetch package
vi.mock("@continuedev/fetch", async () => {
  const actual = await vi.importActual("@continuedev/fetch");
  return {
    ...actual,
    fetchwithRequestOptions: vi.fn(),
  };
});

function createMockStream(mockStream: any[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of mockStream) {
        controller.enqueue(
          encoder.encode(
            `data: ${
              typeof chunk === "string" ? chunk : JSON.stringify(chunk)
            }\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

describe("Anthropic Adapter Tests", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test("should construct API correctly", async () => {
    const { constructLlmApi } = await import("../index.js");
    const api = constructLlmApi({
      provider: "anthropic",
      apiKey: "test-api-key",
    });
    expect(api).toBeDefined();
  });

  test("chatCompletionNonStream should send a valid request", async () => {
    await runAdapterTest({
      config: {
        provider: "anthropic",
        apiKey: "test-api-key",
        apiBase: "https://api.anthropic.com/v1/",
      },
      methodToTest: "chatCompletionNonStream",
      params: [
        {
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          messages: [
            {
              role: "user",
              content: [
                {
                  cache_control: { type: "ephemeral" },
                  type: "text",
                  text: "hello",
                },
              ],
            },
          ],
          system: undefined,
          model: "claude-sonnet-4-5",
          max_tokens: 32000,
          stream: undefined,
        },
      },
      mockResponse: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello! How can I help you today?",
          },
        ],
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 15,
        },
      },
    });
  });

  test("chatCompletionStream should send a valid request", async () => {
    await runAdapterTest({
      config: {
        provider: "anthropic",
        apiKey: "test-api-key",
        apiBase: "https://api.anthropic.com/v1/",
      },
      methodToTest: "chatCompletionStream",
      params: [
        {
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          messages: [
            {
              role: "user",
              content: [
                {
                  cache_control: { type: "ephemeral" },
                  type: "text",
                  text: "hello",
                },
              ],
            },
          ],
          system: undefined,
          model: "claude-sonnet-4-5",
          max_tokens: 32000,
          stream: true,
        },
      },
      mockStream: [
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: " world",
          },
        },
      ],
    });
  });

  test("chatCompletionStream with system message should convert correctly", async () => {
    await runAdapterTest({
      config: {
        provider: "anthropic",
        apiKey: "test-api-key",
        apiBase: "https://api.anthropic.com/v1/",
      },
      methodToTest: "chatCompletionStream",
      params: [
        {
          model: "claude-sonnet-4-5",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "hello" },
          ],
          stream: true,
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          messages: [
            {
              role: "user",
              content: [
                {
                  cache_control: { type: "ephemeral" },
                  type: "text",
                  text: "hello",
                },
              ],
            },
          ],
          system: [
            {
              type: "text",
              text: "You are a helpful assistant.",
              cache_control: { type: "ephemeral" },
            },
          ],
          model: "claude-sonnet-4-5",
          max_tokens: 32000,
          stream: true,
        },
      },
      mockStream: [
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
      ],
    });
  });

  test("chatCompletionNonStream preserves thinking/signature and tool_use blocks", async () => {
    const fetchPackage = await import("@continuedev/fetch");
    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_non_stream",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "tool_use",
          content: [
            {
              type: "thinking",
              thinking: "Need to inspect README first.",
              signature: "sig_non_stream",
            },
            {
              type: "tool_use",
              id: "toolu_non_stream",
              name: "read_file",
              input: { path: "README.md" },
            },
            {
              type: "text",
              text: "Calling read_file with README.md.",
            },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 9,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 1,
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      ) as any,
    );

    const { constructLlmApi } = await import("../index.js");
    const api = constructLlmApi({
      provider: "anthropic",
      apiKey: "test-api-key",
      apiBase: "https://api.anthropic.com/v1/",
    });
    expect(api).toBeDefined();

    const completion = await api!.chatCompletionNonStream(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Read README.md" }],
      },
      new AbortController().signal,
    );

    const message: any = completion.choices[0].message;
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(message.tool_calls).toEqual([
      {
        id: "toolu_non_stream",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      },
    ]);
    expect(message.reasoning_content).toBe("Need to inspect README first.");
    expect(message.reasoning_details).toEqual([
      expect.objectContaining({
        signature: "sig_non_stream",
      }),
    ]);
  });

  test("chatCompletionStream preserves thinking/signature and tool_use deltas", async () => {
    const fetchPackage = await import("@continuedev/fetch");
    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValue(
      new Response(
        createMockStream([
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 9,
                cache_read_input_tokens: 2,
                cache_creation_input_tokens: 0,
              },
            },
          },
          {
            type: "content_block_delta",
            delta: {
              type: "thinking_delta",
              thinking: "Need to inspect inputs.",
            },
          },
          {
            type: "content_block_delta",
            delta: {
              type: "signature_delta",
              signature: "sig_stream",
            },
          },
          {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "toolu_stream",
              name: "read_file",
            },
          },
          {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"README.md"}',
            },
          },
          {
            type: "message_delta",
            usage: {
              output_tokens: 6,
            },
          },
        ]),
        {
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      ) as any,
    );

    const { constructLlmApi } = await import("../index.js");
    const api = constructLlmApi({
      provider: "anthropic",
      apiKey: "test-api-key",
      apiBase: "https://api.anthropic.com/v1/",
    });
    expect(api).toBeDefined();

    const chunks: any[] = [];
    for await (const chunk of api!.chatCompletionStream(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Read README.md" }],
        stream: true,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(
      chunks.some(
        (chunk) =>
          (chunk.choices?.[0]?.delta as any)?.reasoning_content ===
          "Need to inspect inputs.",
      ),
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) =>
          (chunk.choices?.[0]?.delta as any)?.reasoning_details?.[0]
            ?.signature === "sig_stream",
      ),
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) =>
          chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ===
          '{"path":"README.md"}',
      ),
    ).toBe(true);
  });

  test("embed should throw not implemented error", async () => {
    const { constructLlmApi } = await import("../index.js");
    const api = constructLlmApi({
      provider: "anthropic",
      apiKey: "test-api-key",
    });

    await expect(
      api!.embed({
        model: "text-embedding-ada-002",
        input: ["Hello", "World"],
      }),
    ).rejects.toThrow("Method not implemented.");
  });
});
