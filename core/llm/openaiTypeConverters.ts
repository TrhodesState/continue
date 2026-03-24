import { FimCreateParamsStreaming } from "@continuedev/openai-adapters/dist/apis/base";
import {
  createResponsesStreamState as createAdapterResponsesStreamState,
  fromResponsesChunk as fromAdapterResponsesChunk,
  responseToChatCompletion,
} from "@continuedev/openai-adapters/dist/apis/openaiResponses";
import type { ResponsesStreamState as AdapterResponsesStreamState } from "@continuedev/openai-adapters/dist/apis/openaiResponses";
import {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  CompletionCreateParams,
} from "openai/resources/index";
import type {
  EasyInputMessage,
  Response as OpenAIResponse,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.mjs";

import {
  ChatMessage,
  CompletionOptions,
  MessageContent,
  MessagePart,
  TextMessagePart,
  ThinkingChatMessage,
  ToolCallDelta,
} from "..";

function appendReasoningFieldsIfSupported(
  msg: ChatCompletionAssistantMessageParam & {
    reasoning?: string;
    reasoning_content?: string;
    reasoning_details?: any[];
  },
  options: CompletionOptions,
  prevMessage?: ChatMessage,
  providerFlags?: {
    includeReasoningField?: boolean;
    includeReasoningDetailsField?: boolean;
    includeReasoningContentField?: boolean;
  },
) {
  if (!prevMessage || prevMessage.role !== "thinking") return;

  const includeReasoning = !!providerFlags?.includeReasoningField;
  const includeReasoningDetails = !!providerFlags?.includeReasoningDetailsField;
  const includeReasoningContent = !!providerFlags?.includeReasoningContentField;
  if (!includeReasoning && !includeReasoningDetails && !includeReasoningContent)
    return;

  const reasoningDetailsValue =
    prevMessage.reasoning_details ||
    (prevMessage.signature
      ? [{ signature: prevMessage.signature }]
      : undefined);

  // Claude-specific safeguard: prevent errors when switching to Claude after another model.
  // Claude requires a signed reasoning_details block; if missing, we must omit both fields.
  // This check is done before adding any fields to avoid deletes.
  if (
    includeReasoningDetails &&
    options.model.includes("claude") &&
    !(
      Array.isArray(reasoningDetailsValue) &&
      reasoningDetailsValue.some((d) => d && d.signature)
    )
  ) {
    console.warn(
      "Omitting reasoning fields for Claude: no signature present in reasoning_details",
    );
    return;
  }

  if (includeReasoningDetails && reasoningDetailsValue) {
    msg.reasoning_details = reasoningDetailsValue || [];
  }
  if (includeReasoning) {
    msg.reasoning = prevMessage.content as string;
  }
  if (includeReasoningContent) {
    msg.reasoning_content = prevMessage.content as string;
  }
}

export function toChatMessage(
  message: ChatMessage,
  options: CompletionOptions,
  prevMessage?: ChatMessage,
  providerFlags?: {
    includeReasoningField?: boolean;
    includeReasoningDetailsField?: boolean;
    includeReasoningContentField?: boolean;
  },
): ChatCompletionMessageParam | null {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  if (message.role === "system") {
    return {
      role: "system",
      content: message.content,
    };
  }
  if (message.role === "thinking") {
    // Return null - thinking messages are merged into following assistant messages
    return null;
  }

  if (message.role === "assistant") {
    // Base assistant message
    const msg: ChatCompletionAssistantMessageParam & {
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: {
        [key: string]: any;
        signature?: string | undefined;
      }[];
    } = {
      role: "assistant",
      content:
        typeof message.content === "string"
          ? message.content || " " // LM Studio (and other providers) don't accept empty content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part as TextMessagePart),
    };

    // Add tool calls if present
    if (message.toolCalls) {
      msg.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id!,
        type: toolCall.type!,
        function: {
          name: toolCall.function?.name!,
          arguments: toolCall.function?.arguments || "{}",
        },
      }));
    }

    // Preserving reasoning blocks
    appendReasoningFieldsIfSupported(
      msg as any,
      options,
      prevMessage,
      providerFlags,
    );

    return msg as ChatCompletionMessageParam;
  } else {
    if (typeof message.content === "string") {
      return {
        role: "user",
        content: message.content ?? " ", // LM Studio (and other providers) don't accept empty content
      };
    }

    // If no multi-media is in the message, just send as text
    // for compatibility with OpenAI-"compatible" servers
    // that don't support multi-media format
    return {
      role: "user",
      content: message.content.some((item) => item.type !== "text")
        ? message.content.map((part) => {
            if (part.type === "imageUrl") {
              return {
                type: "image_url" as const,
                image_url: {
                  url: part.imageUrl.url,
                  detail: "auto" as const,
                },
              };
            }
            if (part.type === "file") {
              return {
                type: "file" as const,
                file: {
                  file_data: `data:${part.file.mimeType};base64,${part.file.fileData}`,
                  filename: part.file.filename,
                },
              };
            }
            return part;
          })
        : message.content
            .map((item) => (item as TextMessagePart).text)
            .join("") || " ",
    };
  }
}

export function toChatBody(
  messages: ChatMessage[],
  options: CompletionOptions,
  providerFlags?: {
    includeReasoningField?: boolean;
    includeReasoningDetailsField?: boolean;
    includeReasoningContentField?: boolean;
  },
): ChatCompletionCreateParams {
  const params: ChatCompletionCreateParams = {
    messages: messages
      .map((m, index) =>
        toChatMessage(m, options, messages[index - 1], providerFlags),
      )
      .filter((m) => m !== null) as ChatCompletionMessageParam[],
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: options.topP,
    frequency_penalty: options.frequencyPenalty,
    presence_penalty: options.presencePenalty,
    stream: options.stream ?? true,
    stop: options.stop,
    prediction: options.prediction,
    tool_choice: options.toolChoice,
  };

  if (options.tools?.length) {
    params.tools = options.tools
      .filter((tool) => !tool.type || tool.type === "function")
      .map((tool) => ({
        type: tool.type,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: tool.function.strict,
        },
      }));
  }

  return params;
}

export function toCompleteBody(
  prompt: string,
  options: CompletionOptions,
): CompletionCreateParams {
  return {
    prompt,
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: options.topP,
    frequency_penalty: options.frequencyPenalty,
    presence_penalty: options.presencePenalty,
    stream: options.stream ?? true,
    stop: options.stop,
  };
}

export function toFimBody(
  prefix: string,
  suffix: string,
  options: CompletionOptions,
): FimCreateParamsStreaming {
  return {
    model: options.model,
    prompt: prefix,
    suffix,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: options.topP,
    frequency_penalty: options.frequencyPenalty,
    presence_penalty: options.presencePenalty,
    stop: options.stop,
    stream: true,
  } as any;
}

type ResponsesOutputMetadata = {
  responsesOutputItemId?: string;
  responsesOutputItemType?: "message" | "function_call";
  responsesOutputItemIds?: string[];
  responsesMessageItemIds?: string[];
  responsesFunctionCallItemIds?: string[];
  responsesToolCallItemIdsByCallId?: Record<string, string>;
};

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeCallIdMap(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([callId, itemId]) =>
      typeof callId === "string" &&
      callId.length > 0 &&
      typeof itemId === "string" &&
      itemId.length > 0,
  ) as [string, string][];

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function extractResponsesOutputMetadata(
  source: unknown,
): ResponsesOutputMetadata | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const candidate = source as Record<string, unknown>;
  const responsesOutputItemId =
    typeof candidate.responsesOutputItemId === "string" &&
    candidate.responsesOutputItemId.length > 0
      ? candidate.responsesOutputItemId
      : undefined;
  const responsesOutputItemType =
    candidate.responsesOutputItemType === "message" ||
    candidate.responsesOutputItemType === "function_call"
      ? candidate.responsesOutputItemType
      : undefined;
  const responsesOutputItemIds = normalizeStringArray(
    candidate.responsesOutputItemIds,
  );
  const responsesMessageItemIds = normalizeStringArray(
    candidate.responsesMessageItemIds,
  );
  const responsesFunctionCallItemIds = normalizeStringArray(
    candidate.responsesFunctionCallItemIds,
  );
  const responsesToolCallItemIdsByCallId = normalizeCallIdMap(
    candidate.responsesToolCallItemIdsByCallId,
  );

  if (
    !responsesOutputItemId &&
    !responsesOutputItemType &&
    !responsesOutputItemIds &&
    !responsesMessageItemIds &&
    !responsesFunctionCallItemIds &&
    !responsesToolCallItemIdsByCallId
  ) {
    return undefined;
  }

  return {
    ...(responsesOutputItemId ? { responsesOutputItemId } : {}),
    ...(responsesOutputItemType ? { responsesOutputItemType } : {}),
    ...(responsesOutputItemIds ? { responsesOutputItemIds } : {}),
    ...(responsesMessageItemIds ? { responsesMessageItemIds } : {}),
    ...(responsesFunctionCallItemIds ? { responsesFunctionCallItemIds } : {}),
    ...(responsesToolCallItemIdsByCallId
      ? { responsesToolCallItemIdsByCallId }
      : {}),
  };
}

export function fromChatResponse(response: ChatCompletion): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const message = response.choices[0].message as ChatCompletionMessage & {
    reasoning?: string;
    reasoning_content?: string;
    reasoning_details?: {
      signature?: string;
      [key: string]: any;
    }[];
  };
  const responsesMetadata = extractResponsesOutputMetadata(message as any);

  // Check for reasoning content first (similar to fromChatCompletionChunk)
  if (message.reasoning_content || message.reasoning) {
    const thinkingMessage: ChatMessage = {
      role: "thinking",
      content: (message as any).reasoning_content || (message as any).reasoning,
    };

    // Preserve reasoning_details if present
    if (message.reasoning_details) {
      thinkingMessage.reasoning_details = message.reasoning_details;
      // Extract signature from reasoning_details if available
      if (message.reasoning_details[0]?.signature) {
        thinkingMessage.signature = message.reasoning_details[0].signature;
      }
    }

    messages.push(thinkingMessage);
  }

  // Then add the assistant message
  const toolCall = message.tool_calls?.[0];
  if (toolCall) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: message.tool_calls
        ?.filter((tc) => !tc.type || tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: (tc as any).function?.name,
            arguments: (tc as any).function?.arguments,
          },
        })),
      metadata: responsesMetadata,
    });
  } else {
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      metadata: responsesMetadata,
    });
  }

  return messages;
}

export function fromChatCompletionChunk(
  chunk: ChatCompletionChunk,
): ChatMessage | undefined {
  const delta = chunk.choices?.[0]?.delta as
    | (ChatCompletionChunk.Choice.Delta & {
        reasoning?: string;
        reasoning_content?: string;
        reasoning_details?: {
          signature?: string;
        }[];
      })
    | undefined;
  const responsesMetadata = extractResponsesOutputMetadata(delta as any);

  if (delta?.content) {
    return {
      role: "assistant",
      content: delta.content,
      metadata: responsesMetadata,
    };
  } else if (delta?.tool_calls) {
    const toolCalls = delta?.tool_calls
      .filter((tool_call) => !tool_call.type || tool_call.type === "function")
      .map((tool_call) => ({
        id: tool_call.id,
        type: "function" as const,
        function: {
          name: (tool_call as any).function?.name,
          arguments: (tool_call as any).function?.arguments,
        },
      }));

    if (toolCalls.length > 0) {
      return {
        role: "assistant",
        content: "",
        toolCalls,
        metadata: responsesMetadata,
      };
    }
  } else if (
    delta?.reasoning_content ||
    delta?.reasoning ||
    delta?.reasoning_details?.length
  ) {
    const message: ThinkingChatMessage = {
      role: "thinking",
      content: delta.reasoning_content || delta.reasoning || "",
      signature: delta?.reasoning_details?.[0]?.signature,
      reasoning_details: delta?.reasoning_details as any[],
    };
    return message;
  }

  if (responsesMetadata) {
    return {
      role: "assistant",
      content: "",
      metadata: responsesMetadata,
    };
  }

  return undefined;
}

export type ResponsesChunkState = AdapterResponsesStreamState;

export function createResponsesChunkState(model = ""): ResponsesChunkState {
  return createAdapterResponsesStreamState({ model });
}

function isResponsesStreamEvent(event: unknown): event is ResponseStreamEvent {
  const eventType = (event as any)?.type;
  return (
    typeof eventType === "string" &&
    (eventType === "error" || eventType.startsWith("response."))
  );
}

const defaultResponsesChunkState = createResponsesChunkState();

export function fromResponsesChunk(
  event: ResponseStreamEvent | OpenAIResponse,
  state: ResponsesChunkState = defaultResponsesChunkState,
): ChatMessage | ChatMessage[] | undefined {
  if (isResponsesStreamEvent(event)) {
    const chunk = fromAdapterResponsesChunk(state, event);
    return chunk ? fromChatCompletionChunk(chunk) : undefined;
  }

  const completion = responseToChatCompletion(event as any);
  return fromChatResponse(completion as any);
}

export function mergeReasoningDetails(
  existing: any[] | undefined,
  delta: any[] | undefined,
): any[] | undefined {
  if (!delta) return existing;
  if (!existing) return delta;

  const result = [...existing];

  for (const deltaItem of delta) {
    // Skip items without a type
    if (!deltaItem.type) {
      continue;
    }

    // Find existing item with the same type
    const existingIndex = result.findIndex(
      (item) => item.type === deltaItem.type,
    );

    if (existingIndex === -1) {
      // No existing item with this type, add new item
      result.push({ ...deltaItem });
    } else {
      // Merge with existing item of the same type
      const existingItem = result[existingIndex];

      for (const [key, value] of Object.entries(deltaItem)) {
        if (value === null || value === undefined) continue;

        if (key === "text" || key === "signature" || key === "summary") {
          // Concatenate text and signature fields
          existingItem[key] = (existingItem[key] || "") + value;
        } else if (key !== "type") {
          // Don't overwrite type
          // Overwrite other fields
          existingItem[key] = value;
        }
      }
    }
  }

  return result;
}

function getTextFromMessageContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextMessagePart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function toResponseInputContentList(
  parts: MessagePart[],
): ResponseInputMessageContentList {
  const list: ResponseInputMessageContentList = [];
  for (const part of parts) {
    if (part.type === "text") {
      list.push({ type: "input_text", text: part.text });
    } else if (part.type === "imageUrl") {
      list.push({
        type: "input_image",
        image_url: part.imageUrl.url,
        detail: "auto",
      });
    } else if (part.type === "file") {
      list.push({
        type: "input_file",
        file_data: `data:${part.file.mimeType};base64,${part.file.fileData}`,
        filename: part.file.filename,
      } as any);
    }
  }
  return list;
}

/**
 * Emits function_call items for each tool call that has a corresponding fc_ ID.
 * Extracted to reduce cyclomatic complexity in toResponsesInput.
 */
function isResponsesFunctionCallItemId(itemId: string | undefined): boolean {
  return typeof itemId === "string" && itemId.startsWith("fc_");
}

function emitFunctionCallsFromToolCalls(
  toolCalls: ToolCallDelta[],
  options: {
    orderedItemIds?: string[];
    itemIdByCallId?: Record<string, string>;
  },
  input: ResponseInput,
): number {
  const orderedFunctionCallIds = (options.orderedItemIds ?? []).filter(
    (id): id is string => isResponsesFunctionCallItemId(id),
  );
  const itemIdByCallId = options.itemIdByCallId ?? {};
  const usedFunctionCallItemIds = new Set<string>();
  let orderedIndex = 0;
  let emittedCount = 0;

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const callId = tc?.id as string | undefined;
    const name = tc?.function?.name as string | undefined;
    const args = tc?.function?.arguments as string | undefined;

    if (!name || !callId) {
      continue;
    }

    // Strict pairing by call_id when available.
    let functionCallItemId = itemIdByCallId[callId];

    // Fallback for legacy metadata: use ordered list of function_call item IDs.
    if (!isResponsesFunctionCallItemId(functionCallItemId)) {
      while (
        orderedIndex < orderedFunctionCallIds.length &&
        usedFunctionCallItemIds.has(orderedFunctionCallIds[orderedIndex])
      ) {
        orderedIndex++;
      }
      functionCallItemId = orderedFunctionCallIds[orderedIndex];
      orderedIndex++;
    }

    if (!isResponsesFunctionCallItemId(functionCallItemId)) {
      continue;
    }

    usedFunctionCallItemIds.add(functionCallItemId);

    const functionCallItem: ResponseFunctionToolCall = {
      id: functionCallItemId,
      type: "function_call",
      name,
      arguments: typeof args === "string" ? args : "{}",
      call_id: callId,
    };
    input.push(functionCallItem);
    emittedCount++;
  }

  return emittedCount;
}

/**
 * Converts a thinking message's reasoning_details into a ResponseReasoningItem.
 * Extracted to reduce cyclomatic complexity in toResponsesInput.
 */
function convertThinkingMessageToReasoningItem(
  msg: ThinkingChatMessage,
): ResponseReasoningItem | undefined {
  const details = msg.reasoning_details ?? [];
  if (!details.length) return undefined;

  let id: string | undefined;
  let summaryText = "";
  let encrypted: string | undefined;
  let reasoningText = "";

  for (const raw of details as Array<Record<string, unknown>>) {
    const d = raw as {
      type?: string;
      id?: string;
      text?: string;
      encrypted_content?: string;
    };
    if (d.type === "reasoning_id" && d.id) id = d.id;
    else if (d.type === "encrypted_content" && d.encrypted_content)
      encrypted = d.encrypted_content;
    else if (d.type === "summary_text" && typeof d.text === "string")
      summaryText += d.text;
    else if (d.type === "reasoning_text" && typeof d.text === "string")
      reasoningText += d.text;
  }

  if (!id) return undefined;

  const reasoningItem: ResponseReasoningItem = {
    id,
    type: "reasoning",
    summary: [],
  } as ResponseReasoningItem;

  if (summaryText) {
    reasoningItem.summary = [{ type: "summary_text", text: summaryText }];
  }
  if (reasoningText) {
    reasoningItem.content = [{ type: "reasoning_text", text: reasoningText }];
  }
  if (encrypted) {
    reasoningItem.encrypted_content = encrypted;
  }

  return reasoningItem;
}

export function toResponsesInput(messages: ChatMessage[]): ResponseInput {
  const input: ResponseInput = [];

  const pushMessage = (
    role: "user" | "assistant" | "system" | "developer",
    content: string | ResponseInputMessageContentList,
  ) => {
    const normalizedRole: "user" | "assistant" | "system" | "developer" =
      role === "system" ? "developer" : role;
    const easyMsg: EasyInputMessage = {
      role: normalizedRole,
      content,
      type: "message",
    };
    input.push(easyMsg as ResponseInputItem);
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    switch (msg.role) {
      case "system": {
        const content = getTextFromMessageContent(msg.content);
        pushMessage("developer", content || "");
        break;
      }
      case "user": {
        if (typeof msg.content === "string") {
          pushMessage("user", msg.content);
        } else if (Array.isArray(msg.content)) {
          const parts = toResponseInputContentList(
            msg.content as MessagePart[],
          );
          pushMessage("user", parts.length ? parts : "");
        }
        break;
      }
      case "assistant": {
        const text = getTextFromMessageContent(msg.content);

        const respId = msg.metadata?.responsesOutputItemId as
          | string
          | undefined;
        const toolCalls = msg.toolCalls as ToolCallDelta[] | undefined;
        const itemIdByCallId = (msg.metadata
          ?.responsesToolCallItemIdsByCallId ?? {}) as Record<string, string>;
        const orderedFunctionCallIds =
          (msg.metadata?.responsesFunctionCallItemIds as
            | string[]
            | undefined) ||
          (msg.metadata?.responsesOutputItemIds as string[] | undefined) ||
          (respId ? [respId] : []);

        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          // Emit function_call for each tool call with strict call_id pairing when possible.
          const emittedFunctionCalls = emitFunctionCallsFromToolCalls(
            toolCalls,
            { orderedItemIds: orderedFunctionCallIds, itemIdByCallId },
            input,
          );

          // Also emit text content if present alongside tool calls
          if (text && text.trim()) {
            pushMessage("assistant", text);
          }
          // If no IDs were available, preserve the assistant text path (legacy compatibility).
          if (emittedFunctionCalls === 0 && !text.trim()) {
            pushMessage("assistant", "");
          }
        } else if (respId && !isResponsesFunctionCallItemId(respId)) {
          // Emit full assistant output message item
          const outputMessageItem: ResponseOutputMessage = {
            id: respId,
            role: "assistant",
            type: "message",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: text || "",
                annotations: [],
              } satisfies ResponseOutputText,
            ],
          };
          input.push(outputMessageItem);
        } else {
          // Fallback to EasyInput assistant message
          pushMessage("assistant", text || "");
        }
        break;
      }
      case "tool": {
        const call_id = msg.toolCallId;
        const output =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        const functionCallOutput: ResponseInputItem = {
          type: "function_call_output",
          call_id,
          output,
        } as ResponseInputItem;
        input.push(functionCallOutput);
        break;
      }
      case "thinking": {
        const reasoningItem = convertThinkingMessageToReasoningItem(
          msg as ThinkingChatMessage,
        );
        if (reasoningItem) {
          input.push(reasoningItem as ResponseInputItem);
        }
        break;
      }
    }
  }

  return input;
}

export type LlmApiRequestType =
  | "chat"
  | "streamChat"
  | "complete"
  | "streamComplete"
  | "streamFim"
  | "embed"
  | "rerank"
  | "list";
