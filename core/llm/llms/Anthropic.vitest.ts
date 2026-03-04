import { afterEach, describe, expect, test, vi } from "vitest";
import { ILLM } from "../../index.js";
import Anthropic from "./Anthropic.js";

interface LlmTestCase {
  llm: ILLM;
  methodToTest: keyof ILLM;
  params: any[];
  expectedRequest: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Record<string, any>;
  };
  mockResponse?: any;
  mockStream?: any[];
}

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

function setupMockFetch(mockResponse?: any, mockStream?: any[]) {
  const mockFetch = vi.fn();

  if (mockStream) {
    const stream = createMockStream(mockStream);
    mockFetch.mockResolvedValue(
      new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
        },
      }),
    );
  } else {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  return mockFetch;
}

function setupReadableStreamPolyfill() {
  // This can be removed if https://github.com/nodejs/undici/issues/2888 is resolved
  // @ts-ignore
  const originalFrom = ReadableStream.from;
  // @ts-ignore
  ReadableStream.from = (body) => {
    if (body?.source) {
      return body;
    }
    return originalFrom(body);
  };
}

async function executeLlmMethod(
  llm: ILLM,
  methodToTest: keyof ILLM,
  params: any[],
) {
  if (typeof (llm as any)[methodToTest] !== "function") {
    throw new Error(
      `Method ${String(methodToTest)} does not exist on the LLM instance.`,
    );
  }

  const result = await (llm as any)[methodToTest](...params);
  if (result?.next) {
    for await (const _ of result) {
    }
  }
}

function assertFetchCall(mockFetch: any, expectedRequest: any) {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, options] = mockFetch.mock.calls[0];

  expect(url.toString()).toBe(expectedRequest.url);
  expect(options.method).toBe(expectedRequest.method);

  if (expectedRequest.headers) {
    expect(options.headers).toEqual(
      expect.objectContaining(expectedRequest.headers),
    );
  }

  if (expectedRequest.body) {
    const actualBody = JSON.parse(options.body as string);
    expect(actualBody).toEqual(expectedRequest.body);
  }
}

async function runLlmTest(testCase: LlmTestCase) {
  const {
    llm,
    methodToTest,
    params,
    expectedRequest,
    mockResponse,
    mockStream,
  } = testCase;

  const mockFetch = setupMockFetch(mockResponse, mockStream);
  setupReadableStreamPolyfill();

  (llm as any).fetch = mockFetch;

  await executeLlmMethod(llm, methodToTest, params);
  assertFetchCall(mockFetch, expectedRequest);
}

describe("Anthropic", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("streamChat should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "streamChat",
      params: [
        [{ role: "user", content: "hello" }],
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
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello! How can I help you today?"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  test("chat should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "chat",
      params: [
        [{ role: "user", content: "hello" }],
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
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello! How can I help you today?"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  test("streamComplete should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "streamComplete",
      params: ["Complete this: Hello", new AbortController().signal],
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
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Complete this: Hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world!"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  test("complete should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "complete",
      params: ["Complete this: Hello", new AbortController().signal],
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
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Complete this: Hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world!"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  describe("Different configurations", () => {
    test("should handle system message", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      await runLlmTest({
        llm: anthropic,
        methodToTest: "streamChat",
        params: [
          [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello!" },
          ],
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
            model: "claude-sonnet-4-5",
            max_tokens: 8192,
            stream: true,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Hello!" }],
              },
            ],
            system: "You are a helpful assistant.",
          },
        },
        mockStream: [
          '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello! How can I help you today?"}}',
          '{"type": "content_block_stop"}',
        ],
      });
    });

    test("should handle tool calls", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      const tools = [
        {
          type: "function" as const,
          function: {
            name: "get_weather",
            description: "Get the current weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ];

      await runLlmTest({
        llm: anthropic,
        methodToTest: "streamChat",
        params: [
          [{ role: "user", content: "What's the weather in New York?" }],
          new AbortController().signal,
          { tools },
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
            model: "claude-sonnet-4-5",
            max_tokens: 8192,
            stream: true,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What's the weather in New York?" },
                ],
              },
            ],
            tools: [
              {
                name: "get_weather",
                description: "Get the current weather",
                input_schema: {
                  type: "object",
                  properties: {
                    location: { type: "string" },
                  },
                  required: ["location"],
                },
              },
            ],
            system: "",
          },
        },
        mockStream: [
          '{"type": "content_block_start", "content_block": {"type": "tool_use", "id": "toolu_123", "name": "get_weather"}}',
          '{"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{\\"location\\": \\"New York\\""}}',
          '{"type": "content_block_stop"}',
        ],
      });
    });

    test("should handle custom max tokens", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      await runLlmTest({
        llm: anthropic,
        methodToTest: "streamChat",
        params: [
          [{ role: "user", content: "hello" }],
          new AbortController().signal,
          { maxTokens: 1000 },
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
            model: "claude-sonnet-4-5",
            max_tokens: 1000,
            stream: true,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "hello" }],
              },
            ],
            system: "",
          },
        },
        mockStream: [
          '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello!"}}',
          '{"type": "content_block_stop"}',
        ],
      });
    });
  });

  describe("Error handling", () => {
    test("should throw error when API key is missing", async () => {
      const anthropic = new Anthropic({
        apiKey: "",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      await expect(
        runLlmTest({
          llm: anthropic,
          methodToTest: "streamChat",
          params: [
            [{ role: "user", content: "hello" }],
            new AbortController().signal,
          ],
          expectedRequest: {
            url: "https://api.anthropic.com/v1/messages",
            method: "POST",
          },
        }),
      ).rejects.toThrow(
        "Request not sent. You have an Anthropic model configured in your config.yaml, but the API key is not set.",
      );
    });
  });

  describe("responses parity", () => {
    test("handleResponse non-stream preserves thinking/signature and tool_use blocks", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-opus-4-6",
        apiBase: "https://api.anthropic.com/v1/",
      });

      const response = new Response(
        JSON.stringify({
          id: "msg_1",
          content: [
            {
              type: "thinking",
              thinking: "I should inspect files first.",
              signature: "sig_non_stream",
            },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "README.md" },
            },
            {
              type: "text",
              text: "Calling read_file for README.md.",
            },
          ],
          usage: {
            input_tokens: 15,
            output_tokens: 7,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );

      const chunks: any[] = [];
      for await (const chunk of anthropic.handleResponse(
        response as any,
        false,
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "thinking",
            content: "I should inspect files first.",
            signature: "sig_non_stream",
          }),
          expect.objectContaining({
            role: "assistant",
            toolCalls: [
              expect.objectContaining({
                id: "toolu_1",
                function: expect.objectContaining({
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                }),
              }),
            ],
          }),
          expect.objectContaining({
            role: "assistant",
            content: "Calling read_file for README.md.",
          }),
          expect.objectContaining({
            role: "assistant",
            usage: expect.objectContaining({
              promptTokens: 15,
              completionTokens: 7,
            }),
          }),
        ]),
      );
    });

    test("handleResponse stream preserves thinking/signature and tool_use deltas", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-opus-4-6",
        apiBase: "https://api.anthropic.com/v1/",
      });

      const fetchPackage = await import("@continuedev/fetch");
      vi.spyOn(fetchPackage, "streamSse").mockImplementation(
        async function* () {
          yield {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 11,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 0,
              },
            },
          } as any;
          yield {
            type: "content_block_delta",
            delta: {
              type: "thinking_delta",
              thinking: "Need to inspect file metadata.",
            },
          } as any;
          yield {
            type: "content_block_delta",
            delta: {
              type: "signature_delta",
              signature: "sig_stream",
            },
          } as any;
          yield {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "toolu_stream",
              name: "read_file",
            },
          } as any;
          yield {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"README.md"}',
            },
          } as any;
          yield {
            type: "message_delta",
            usage: {
              output_tokens: 9,
            },
          } as any;
          yield {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "Running read_file now.",
            },
          } as any;
          yield {
            type: "content_block_stop",
          } as any;
        },
      );
      const response = new Response(null, {
        headers: {
          "Content-Type": "text/event-stream",
        },
      });

      const chunks: any[] = [];
      for await (const chunk of anthropic.handleResponse(
        response as any,
        true,
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "thinking",
            content: "Need to inspect file metadata.",
          }),
          expect.objectContaining({
            role: "thinking",
            signature: "sig_stream",
          }),
          expect.objectContaining({
            role: "assistant",
            toolCalls: [
              expect.objectContaining({
                id: "toolu_stream",
                function: expect.objectContaining({
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                }),
              }),
            ],
          }),
          expect.objectContaining({
            role: "assistant",
            content: "Running read_file now.",
          }),
          expect.objectContaining({
            role: "assistant",
            usage: expect.objectContaining({
              promptTokens: 11,
              completionTokens: 9,
            }),
          }),
        ]),
      );
    });
  });
});
