import { afterEach, describe, expect, test, vi } from "vitest";

import { constructLlmApi } from "../index.js";

vi.mock("@continuedev/fetch", async () => {
  const actual = await vi.importActual("@continuedev/fetch");
  return {
    ...actual,
    fetchwithRequestOptions: vi.fn(),
  };
});

function createMockStream(mockEvents: any[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of mockEvents) {
        controller.enqueue(
          encoder.encode(
            `data: ${
              typeof event === "string" ? event : JSON.stringify(event)
            }\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

const AZURE_BASE = "https://example-resource.cognitiveservices.azure.com";
const AZURE_API_VERSION = "2025-04-01-preview";

describe("Azure responses routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test("routes gpt-5 codex non-stream requests to Azure responses endpoint", async () => {
    const fetchPackage = await import("@continuedev/fetch");
    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_azure_codex_nonstream",
          object: "response",
          created_at: 1710000300,
          model: "gpt-5.3-codex",
          output_text: "Azure responses path works.",
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          parallel_tool_calls: false,
          temperature: null,
          tool_choice: null,
          tools: [],
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Azure responses path works.",
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 6,
            total_tokens: 16,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as any,
    );

    const api = constructLlmApi({
      provider: "azure",
      apiKey: "test-api-key",
      apiBase: AZURE_BASE,
      env: {
        deployment: "gpt-5.3-codex",
        apiType: "azure-openai",
        apiVersion: AZURE_API_VERSION,
      },
    })!;

    const response = await api.chatCompletionNonStream(
      {
        model: "gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
      } as any,
      new AbortController().signal,
    );

    const mockFetch = vi.mocked(fetchPackage.fetchwithRequestOptions);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe(
      `${AZURE_BASE}/openai/responses?api-version=${AZURE_API_VERSION}`,
    );
    expect(options).toBeDefined();
    const requestInit = options as RequestInit;
    expect(requestInit.method).toBe("POST");
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody.model).toBe("gpt-5.3-codex");
    expect(parsedBody.stream).toBe(false);
    expect(parsedBody.input[0]).toMatchObject({
      role: "user",
      type: "message",
    });
    expect(response.choices[0].message.content).toContain("Azure responses");
  });

  test("routes gpt-5 codex stream requests to Azure responses endpoint", async () => {
    const fetchPackage = await import("@continuedev/fetch");
    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValue(
      new Response(
        createMockStream([
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
              id: "msg_stream_1",
              type: "message",
              role: "assistant",
              content: [],
            },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            item_id: "msg_stream_1",
            output_index: 0,
            content_index: 0,
            delta: "Hello from Azure responses stream",
            logprobs: [],
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ) as any,
    );

    const api = constructLlmApi({
      provider: "azure",
      apiKey: "test-api-key",
      apiBase: AZURE_BASE,
      env: {
        deployment: "gpt-5.3-codex",
        apiType: "azure-openai",
        apiVersion: AZURE_API_VERSION,
      },
    })!;

    const chunks = [];
    for await (const chunk of api.chatCompletionStream(
      {
        model: "gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      } as any,
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const mockFetch = vi.mocked(fetchPackage.fetchwithRequestOptions);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe(
      `${AZURE_BASE}/openai/responses?api-version=${AZURE_API_VERSION}`,
    );
    expect(options).toBeDefined();
    const requestInit = options as RequestInit;
    expect(requestInit.method).toBe("POST");
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody.model).toBe("gpt-5.3-codex");
    expect(parsedBody.stream).toBe(true);
    expect(
      chunks.some((chunk) =>
        chunk.choices[0]?.delta?.content?.includes("Azure responses stream"),
      ),
    ).toBe(true);
  });

  test("keeps deployment-scoped chat/completions for non-responses Azure models", async () => {
    const fetchPackage = await import("@continuedev/fetch");
    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_azure_gpt4o",
          object: "chat.completion",
          created: 1710000400,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "hello from chat completions",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 5,
            total_tokens: 10,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as any,
    );

    const api = constructLlmApi({
      provider: "azure",
      apiKey: "test-api-key",
      apiBase: AZURE_BASE,
      env: {
        deployment: "gpt-4o",
        apiType: "azure-openai",
        apiVersion: AZURE_API_VERSION,
      },
    })!;

    const response = await api.chatCompletionNonStream(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      } as any,
      new AbortController().signal,
    );

    const mockFetch = vi.mocked(fetchPackage.fetchwithRequestOptions);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe(
      `${AZURE_BASE}/openai/deployments/gpt-4o/chat/completions?api-version=${AZURE_API_VERSION}`,
    );
    expect(options).toBeDefined();
    const requestInit = options as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(response.choices[0].message.content).toContain("chat completions");
  });
});
