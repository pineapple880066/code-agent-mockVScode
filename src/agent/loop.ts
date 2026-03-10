import { buildSystemPrompt } from "./prompt.js";
import type { SessionRecord } from "./session.js";
import type { AgentEventHandler, ChatProvider, ProviderMessage, SessionMessage } from "./types.js";
import type { ToolRegistry } from "../tools/definitions.js";
import type { IndexManager } from "../rag/index-manager.js";

export async function runAgentLoop(params: {
  provider: ChatProvider;
  toolRegistry: ToolRegistry;
  indexManager: IndexManager;
  model: string;
  workspaceRoot: string;
  session: SessionRecord;
  prompt: string;
  maxSteps: number;
  onEvent?: AgentEventHandler;
}): Promise<{ reply: string; session: SessionRecord; steps: number }> {
  await params.onEvent?.({
    type: "status",
    message: "Retrieving relevant code context.",
  });

  const retrievedContext = await params.indexManager.retrieveContext(params.prompt);
  const conversation: ProviderMessage[] = [
    { role: "system", content: buildSystemPrompt(params.workspaceRoot, retrievedContext) },
    ...params.session.messages,
    { role: "user", content: params.prompt },
  ];

  const persistedMessages: SessionMessage[] = [{ role: "user", content: params.prompt }];

  for (let step = 1; step <= params.maxSteps; step += 1) {
    await params.onEvent?.({
      type: "status",
      message: `Running agent step ${step}.`,
    });

    const completion = await params.provider.complete({
      model: params.model,
      messages: conversation,
      tools: params.toolRegistry.specs,
      temperature: 0.2,
    });

    const assistantMessage: SessionMessage = {
      role: "assistant",
      content: completion.text,
      ...(completion.toolCalls.length > 0 ? { toolCalls: completion.toolCalls } : {}),
    };

    conversation.push(assistantMessage);
    persistedMessages.push(assistantMessage);

    if (completion.toolCalls.length === 0) {
      return {
        reply: completion.text.trim() || "(empty response)",
        steps: step,
        session: {
          ...params.session,
          messages: [...params.session.messages, ...persistedMessages],
        },
      };
    }

    for (const toolCall of completion.toolCalls) {
      await params.onEvent?.({
        type: "tool_start",
        toolName: toolCall.name,
        arguments: toolCall.arguments,
      });

      const toolResult = await params.toolRegistry.execute(toolCall);
      const toolMessage: SessionMessage = {
        role: "tool",
        name: toolCall.name,
        toolCallId: toolCall.id,
        content: toolResult,
      };

      conversation.push(toolMessage);
      persistedMessages.push(toolMessage);

      await params.onEvent?.({
        type: "tool_end",
        toolName: toolCall.name,
        result: toolResult,
      });
    }
  }

  throw new Error(`Agent stopped after ${params.maxSteps} steps without a final answer.`);
}
