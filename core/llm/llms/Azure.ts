import { LLMOptions } from "../../index.js";
import { LlmApiRequestType } from "../openaiTypeConverters.js";

import OpenAI from "./OpenAI.js";

class Azure extends OpenAI {
  static providerName = "azure";

  protected supportsPrediction(model: string): boolean {
    return false;
  }

  // Route chat through the adapter so Azure can use Responses API for Codex/GPT-5 models.
  protected useOpenAIAdapterFor: (LlmApiRequestType | "*")[] = [
    "chat",
    "streamChat",
  ];

  static defaultOptions: Partial<LLMOptions> = {
    apiVersion: "2024-02-15-preview",
    apiType: "azure-openai",
  };

  constructor(options: LLMOptions) {
    super(options);
    this.deployment = options.deployment ?? options.model;
  }
}

export default Azure;
