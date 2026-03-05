import { streamSse } from "@continuedev/fetch";
import { OpenAI } from "openai/index";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/index";
import type {
  Response as ResponsesApiResponse,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { z } from "zod";
import { AzureConfigSchema } from "../types.js";
import { customFetch } from "../util.js";
import { OpenAIApi } from "./OpenAI.js";
import {
  createResponsesStreamState,
  fromResponsesChunk,
  isResponsesModel,
  responseToChatCompletion,
  toResponsesParams,
} from "./openaiResponses.js";

export class AzureApi extends OpenAIApi {
  constructor(private azureConfig: z.infer<typeof AzureConfigSchema>) {
    super({
      ...azureConfig,
      provider: "openai",
    });

    const { baseURL, defaultQuery } = this._getAzureBaseURL(azureConfig);

    this.openai = new OpenAI({
      apiKey: azureConfig.apiKey,
      baseURL,
      fetch: customFetch(azureConfig.requestOptions),
      defaultQuery,
    });
  }

  /**
   * Default is `azure-openai`, but previously was `azure`
   * @param apiType
   * @returns
   */
  private _isAzureOpenAI(apiType?: string): boolean {
    return apiType === "azure-openai" || apiType === "azure";
  }

  private _getAzureBaseURL(config: z.infer<typeof AzureConfigSchema>): {
    baseURL: string;
    defaultQuery: Record<string, string>;
  } {
    const url = new URL(this.apiBase);

    // Copy search params to separate object for OpenAI
    const queryParams: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      queryParams[key] = value;
    }

    url.pathname = url.pathname.replace(/\/$/, ""); // Remove trailing slash if present
    url.search = ""; // Clear original search params

    // Default is `azure-openai` in docs, but previously was `azure`
    if (this._isAzureOpenAI(config.env?.apiType)) {
      if (!config.env?.deployment) {
        throw new Error(
          "`env.deployment` is a required configuration property for Azure OpenAI",
        );
      }

      if (!config.env?.apiVersion) {
        throw new Error(
          "`env.apiVersion` is a required configuration property for Azure OpenAI",
        );
      }

      const basePathname = `openai/deployments/${config.env.deployment}`;

      url.pathname =
        url.pathname === "/" ? basePathname : `${url.pathname}/${basePathname}`;

      queryParams["api-version"] = config.env.apiVersion;
    }

    return {
      baseURL: url.toString(),
      defaultQuery: queryParams,
    };
  }

  protected shouldUseResponsesEndpoint(model: string): boolean {
    if (!this._isAzureOpenAI(this.azureConfig.env?.apiType)) {
      return false;
    }

    return isResponsesModel(model, this.azureConfig.responsesModelAliases);
  }

  private _getAzureResponsesEndpoint(): URL {
    const url = new URL(this.apiBase);
    const apiVersionFromBase = url.searchParams.get("api-version");
    const apiVersion = this.azureConfig.env?.apiVersion ?? apiVersionFromBase;

    url.search = "";

    let pathname = url.pathname.replace(/\/+$/, "");
    // If a deployment-scoped path is provided, normalize back to resource root.
    pathname = pathname.replace(/\/openai\/deployments\/[^/]+$/i, "");

    if (!/\/openai\/responses$/i.test(pathname)) {
      pathname =
        pathname.length > 0
          ? `${pathname}/openai/responses`
          : "/openai/responses";
    }
    url.pathname = pathname;

    if (apiVersion) {
      url.searchParams.set("api-version", apiVersion);
    }

    return url;
  }

  private _getAzureHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": this.azureConfig.apiKey ?? "",
      "x-api-key": this.azureConfig.apiKey ?? "",
      Authorization: `Bearer ${this.azureConfig.apiKey ?? ""}`,
    };
  }

  /**
   * Filters out empty text content parts from messages.
   *
   * Azure models may not support empty content parts, which can cause issues.
   * This function removes any text content parts that are empty or contain only whitespace.
   */
  private _filterEmptyContentParts<T extends ChatCompletionCreateParams>(
    body: T,
  ): T {
    const result = { ...body };

    result.messages = result.messages.map((message: any) => {
      if (Array.isArray(message.content)) {
        const filteredContent = message.content.filter((part: any) => {
          return !(
            part.type === "text" &&
            (!part.text || part.text.trim() === "")
          );
        });
        return {
          ...message,
          content:
            filteredContent.length > 0 ? filteredContent : message.content,
        };
      }
      return message;
    }) as any;

    return result;
  }

  modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    let modifiedBody = super.modifyChatBody(body);
    modifiedBody = this._filterEmptyContentParts(modifiedBody);
    return modifiedBody;
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    if (this.shouldUseResponsesEndpoint(body.model)) {
      const response = await this.responsesNonStream(body, signal);
      return responseToChatCompletion(response);
    }

    return super.chatCompletionNonStream(body, signal);
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    if (this.shouldUseResponsesEndpoint(body.model)) {
      for await (const chunk of this.responsesStream(body, signal)) {
        yield chunk;
      }
      return;
    }

    const response = await this.openai.chat.completions.create(
      this.modifyChatBody(body),
      { signal },
    );

    for await (const result of response) {
      // Skip chunks with no choices (common with Azure content filtering)
      if (result.choices && result.choices.length > 0) {
        yield result;
      }
    }
  }

  async responsesNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ResponsesApiResponse> {
    const endpoint = this._getAzureResponsesEndpoint();
    const params = toResponsesParams({
      ...(body as ChatCompletionCreateParams),
      stream: false,
    });

    const response = await customFetch(this.azureConfig.requestOptions)(
      endpoint,
      {
        method: "POST",
        headers: this._getAzureHeaders(),
        body: JSON.stringify(params),
        signal,
      },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return (await response.json()) as ResponsesApiResponse;
  }

  async *responsesStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const endpoint = this._getAzureResponsesEndpoint();
    const params = toResponsesParams({
      ...(body as ChatCompletionCreateParams),
      stream: true,
    });
    const state = createResponsesStreamState({
      model: body.model,
    });

    const response = await customFetch(this.azureConfig.requestOptions)(
      endpoint,
      {
        method: "POST",
        headers: this._getAzureHeaders(),
        body: JSON.stringify(params),
        signal,
      },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    for await (const event of streamSse(response as any)) {
      const chunk = fromResponsesChunk(state, event as ResponseStreamEvent);
      if (chunk) {
        yield chunk;
      }
    }
  }
}
