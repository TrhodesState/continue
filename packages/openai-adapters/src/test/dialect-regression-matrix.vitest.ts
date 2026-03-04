import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import { AnthropicApi } from "../apis/Anthropic.js";
import {
  createResponsesStreamState,
  fromResponsesChunk,
  responseToChatCompletion,
} from "../apis/openaiResponses.js";

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

describe("dialect regression matrix", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("covers codex responses streaming and non-streaming translations", () => {
    const streamState = createResponsesStreamState({
      model: "codex-5.3",
      responseId: "resp_matrix_codex",
      created: 1710000200,
    });

    const streamEvents = [
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: {
          id: "msg_matrix_1",
          type: "message",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_matrix_1",
        output_index: 0,
        content_index: 0,
        delta: "Analyzing workspace...",
      },
      {
        type: "response.output_item.added",
        sequence_number: 3,
        output_index: 1,
        item: {
          id: "fc_matrix_1",
          type: "function_call",
          call_id: "call_matrix_1",
          name: "read_file",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 4,
        item_id: "fc_matrix_1",
        output_index: 1,
        delta: '{"path":"README.md"}',
      },
      {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 1,
        item: {
          id: "fc_matrix_1",
          type: "function_call",
          call_id: "call_matrix_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
          status: "completed",
        },
      },
    ] as any[];

    const streamChunks = streamEvents
      .map((event) => fromResponsesChunk(streamState, event))
      .filter(Boolean);

    expect(
      streamChunks.some((chunk) => chunk?.choices[0]?.delta?.content),
    ).toBe(true);
    expect(
      streamChunks.some(
        (chunk) =>
          chunk?.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments ===
          '{"path":"README.md"}',
      ),
    ).toBe(true);
    expect(
      streamChunks.some(
        (chunk) => chunk?.choices[0]?.finish_reason === "tool_calls",
      ),
    ).toBe(true);

    const nonStreamResponse = {
      id: "resp_matrix_codex",
      object: "response",
      created_at: 1710000203,
      model: "codex-5.3",
      output_text: "Calling read_file now.",
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
          id: "fc_matrix_1",
          type: "function_call",
          call_id: "call_matrix_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
          status: "completed",
        },
        {
          id: "msg_matrix_2",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Calling read_file now.",
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 30,
        output_tokens: 10,
        total_tokens: 40,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    } as unknown as Response;

    const completion = responseToChatCompletion(nonStreamResponse);
    expect(completion.model).toBe("codex-5.3");
    expect(completion.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: "call_matrix_1",
      function: {
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    });
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
  });

  it("covers claude opus 4.6 messages streaming and non-streaming translations", async () => {
    const fetchPackage = await import("@continuedev/fetch");

    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "msg_matrix_opus_non_stream",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-6",
          stop_reason: "tool_use",
          content: [
            {
              type: "thinking",
              thinking: "Need to inspect configuration first.",
              signature: "sig_matrix_non_stream",
            },
            {
              type: "tool_use",
              id: "toolu_matrix_non_stream",
              name: "read_file",
              input: { path: "README.md" },
            },
            {
              type: "text",
              text: "Running read_file.",
            },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 12,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as any,
    );

    vi.mocked(fetchPackage.fetchwithRequestOptions).mockResolvedValueOnce(
      new Response(
        createMockStream([
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "thinking",
              thinking: "",
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "thinking_delta",
              thinking: "Let me reason this through.",
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "signature_delta",
              signature: "sig_matrix_stream",
            },
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "toolu_matrix_stream",
              name: "read_file",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"README.md"}',
            },
          },
          {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "text",
              text: "",
            },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: {
              type: "text_delta",
              text: "Running read_file.",
            },
          },
          {
            type: "message_delta",
            delta: {
              stop_reason: "tool_use",
            },
            usage: {
              output_tokens: 18,
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ) as any,
    );

    const api = new AnthropicApi({
      provider: "anthropic",
      apiKey: "test-api-key",
      apiBase: "https://api.anthropic.com/v1/",
    } as any);

    const nonStream = await api.chatCompletionNonStream(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Inspect README and summarize." }],
      } as any,
      new AbortController().signal,
    );

    expect((nonStream.choices[0].message as any).reasoning_content).toContain(
      "Need to inspect configuration first.",
    );
    expect(nonStream.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: "toolu_matrix_non_stream",
      function: {
        name: "read_file",
      },
    });
    expect(nonStream.choices[0].finish_reason).toBe("tool_calls");

    const streamChunks = [];
    for await (const chunk of api.chatCompletionStream(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Inspect README and summarize." }],
        stream: true,
      } as any,
      new AbortController().signal,
    )) {
      streamChunks.push(chunk);
    }

    expect(
      streamChunks.some((chunk) =>
        (chunk.choices[0]?.delta as any)?.reasoning_content?.includes(
          "Let me reason",
        ),
      ),
    ).toBe(true);
    expect(
      streamChunks.some(
        (chunk) =>
          (chunk.choices[0]?.delta as any)?.reasoning_details?.[0]
            ?.signature === "sig_matrix_stream",
      ),
    ).toBe(true);
    expect(
      streamChunks.some(
        (chunk) =>
          chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments ===
          '{"path":"README.md"}',
      ),
    ).toBe(true);
  });
});
