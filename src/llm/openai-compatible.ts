import type { ChatProvider, CompletionResponse, ProviderMessage, ToolCall, ToolSpec } from "../agent/types.js";
import type { ChatConfig } from "../config.js";

type ApiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type ApiResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: ApiToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type ApiMessageContent = string | Array<{ type?: string; text?: string }> | null | undefined;

function toApiMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toApiTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function readMessageText(content: ApiMessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function normalizeToolCalls(toolCalls: ApiToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter((toolCall) => toolCall.function?.name)
    .map((toolCall, index) => ({
      id: toolCall.id || `tool_call_${index + 1}`,
      name: toolCall.function?.name?.trim() || "unknown_tool",
      arguments: toolCall.function?.arguments ?? "{}",
    }));
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly #config: ChatConfig;

  constructor(config: ChatConfig) {
    this.#config = config;
  }

  async complete(params: {
    model: string;
    messages: ProviderMessage[];
    tools: ToolSpec[];
    temperature?: number;
  }): Promise<CompletionResponse> {
    const response = await fetch(`${this.#config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages.map(toApiMessage),
        tools: params.tools.map(toApiTool),
        tool_choice: "auto",
        temperature: params.temperature ?? 0.2,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as ApiResponse;
    const message = payload.choices?.[0]?.message;

    if (!message) {
      throw new Error("LLM response did not contain a message.");
    }

    return {
      text: readMessageText(message.content),
      toolCalls: normalizeToolCalls(message.tool_calls),
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens,
      },
    };
  }
}
