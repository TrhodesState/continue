import { describe, expect, it } from "vitest";

import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/index.js";
import type {
  Response,
  ResponseOutputItemAddedEvent,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
} from "openai/resources/responses/responses.js";

import {
  createResponsesStreamState,
  fromResponsesChunk,
  isResponsesModel,
  resolveApiDialect,
  responseToChatCompletion,
  toResponsesParams,
} from "../apis/openaiResponses.js";

describe("openai responses codex roundtrip", () => {
  it("detects codex-family models as responses models", () => {
    expect(isResponsesModel("gpt-5-codex")).toBe(true);
    expect(isResponsesModel("codex-5.3")).toBe(true);
    expect(isResponsesModel("codex-5-3-preview")).toBe(true);
    expect(isResponsesModel("gpt-4o")).toBe(false);
  });

  it("routes through a single API dialect decision path", () => {
    expect(
      resolveApiDialect({
        model: "codex-5.3",
        apiBase: "https://api.openai.com/v1/",
        supportsResponsesApi: true,
      }),
    ).toBe("openai-responses");

    expect(
      resolveApiDialect({
        model: "codex-5.3",
        apiBase: "https://custom-proxy.example/v1/",
        supportsResponsesApi: true,
      }),
    ).toBe("openai-chat");

    expect(
      resolveApiDialect({
        model: "claude-opus-4-6",
      }),
    ).toBe("anthropic-messages");
  });

  it("supports a full request/stream/final-response cycle for codex responses models", () => {
    const request: ChatCompletionCreateParamsNonStreaming = {
      model: "codex-5.3",
      stream: false,
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "Read README.md and summarize." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "fc_read_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "fc_read_1",
          content: "README content",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
      ],
    };

    const responsesRequest = toResponsesParams(request);

    expect(responsesRequest.model).toBe("codex-5.3");
    expect(responsesRequest.input).toMatchObject([
      {
        type: "message",
        role: "developer",
      },
      {
        type: "message",
        role: "user",
      },
      {
        type: "function_call",
        id: "fc_read_1",
        call_id: "fc_read_1",
        name: "read_file",
      },
      {
        type: "function_call_output",
        call_id: "fc_read_1",
        output: "README content",
      },
    ]);

    const state = createResponsesStreamState({
      model: request.model,
      responseId: "resp_codex",
      created: 1710000100,
    });
    const events: ResponseStreamEvent[] = [
      {
        type: "response.created",
        sequence_number: 1,
        response: {
          id: "resp_codex",
          object: "response",
          created_at: 1710000100,
          model: "codex-5.3",
          output: [],
          tools: [],
          parallel_tool_calls: false,
          tool_choice: null,
          temperature: null,
          top_p: null,
          metadata: null,
          output_text: "",
          error: null,
          incomplete_details: null,
        } as any,
      },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
        } as any,
      } as ResponseOutputItemAddedEvent,
      {
        type: "response.output_text.delta",
        sequence_number: 3,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "Analyzing README...",
        logprobs: [],
      } as ResponseTextDeltaEvent,
      {
        type: "response.output_item.added",
        sequence_number: 4,
        output_index: 1,
        item: {
          id: "fc_read_2",
          type: "function_call",
          call_id: "call_read_2",
          name: "read_file",
          arguments: "",
          status: "in_progress",
        } as any,
      } as ResponseOutputItemAddedEvent,
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 5,
        item_id: "fc_read_2",
        output_index: 1,
        delta: '{"path":"README.md"}',
      } as any,
      {
        type: "response.output_item.done",
        sequence_number: 6,
        output_index: 1,
        item: {
          id: "fc_read_2",
          type: "function_call",
          call_id: "call_read_2",
          name: "read_file",
          arguments: '{"path":"README.md"}',
          status: "completed",
        } as any,
      } as any,
    ];

    const streamChunks = events
      .map((event) => fromResponsesChunk(state, event))
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

    const finalResponse = {
      id: "resp_codex",
      object: "response",
      created_at: 1710000102,
      model: "codex-5.3",
      output_text: "Calling read_file to inspect README.md.",
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
          id: "fc_read_2",
          type: "function_call",
          call_id: "call_read_2",
          name: "read_file",
          arguments: '{"path":"README.md"}',
          status: "completed",
        },
        {
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Calling read_file to inspect README.md.",
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 12,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 52,
      },
    } as unknown as Response;

    const completion = responseToChatCompletion(finalResponse);
    expect(completion.model).toBe("codex-5.3");
    expect(completion.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: "call_read_2",
      function: {
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    });
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(completion.usage?.total_tokens).toBe(52);
  });
});
