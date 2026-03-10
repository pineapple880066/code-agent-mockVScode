export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type SessionMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
      name: string;
    };

export type ProviderMessage =
  | {
      role: "system";
      content: string;
    }
  | SessionMessage;

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CompletionResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

export interface ChatProvider {
  complete(params: {
    model: string;
    messages: ProviderMessage[];
    tools: ToolSpec[];
    temperature?: number;
  }): Promise<CompletionResponse>;
}

export type ToolRunEvent =
  | {
      type: "status";
      message: string;
    }
  | {
      type: "tool_start";
      toolName: string;
      arguments: string;
    }
  | {
      type: "tool_end";
      toolName: string;
      result: string;
    };

export type AgentEventHandler = (event: ToolRunEvent) => void | Promise<void>;
