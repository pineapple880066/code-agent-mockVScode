import path from "node:path";

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) {
      return value.trim();
    }
  }

  return "";
}

export type ChatConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type EmbeddingConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
} | null;

export type ServerConfig = {
  port: number;
  workspaceRoot: string;
  authToken: string | null;
};

export function resolveWorkspaceRoot(defaultRoot = process.cwd()): string {
  return path.resolve(process.env.CODE_AGENT_WORKSPACE?.trim() || defaultRoot);
}

export function resolveChatConfig(): ChatConfig {
  const apiKey = firstNonBlank(
    process.env.CHAT_API_KEY,
    process.env.CODE_AGENT_API_KEY,
    process.env.MINIMAX_API_KEY,
    process.env.OPENAI_API_KEY,
  );

  if (!apiKey.trim()) {
    throw new Error(
      "Missing chat API key. Set CHAT_API_KEY, MINIMAX_API_KEY, CODE_AGENT_API_KEY, or OPENAI_API_KEY.",
    );
  }

  return {
    apiKey,
    baseUrl: firstNonBlank(
      process.env.CHAT_BASE_URL,
      process.env.CODE_AGENT_BASE_URL,
      process.env.OPENAI_BASE_URL,
      "https://api.minimaxi.com/v1",
    ).replace(/\/+$/, ""),
    model: firstNonBlank(
      process.env.CHAT_MODEL,
      process.env.CODE_AGENT_MODEL,
      process.env.OPENAI_MODEL,
      "MiniMax-M2.5",
    ),
  };
}

export function resolveEmbeddingConfig(): EmbeddingConfig {
  const model = process.env.EMBEDDING_MODEL?.trim();
  const apiKey = process.env.EMBEDDING_API_KEY?.trim();
  const baseUrl = process.env.EMBEDDING_BASE_URL?.trim();

  if (!model || !apiKey || !baseUrl) {
    return null;
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
  };
}

export function resolveServerConfig(workspaceRoot = resolveWorkspaceRoot()): ServerConfig {
  return {
    port: parsePort(process.env.CODE_AGENT_PORT, 3000),
    workspaceRoot: path.resolve(workspaceRoot),
    authToken: process.env.CODE_AGENT_AUTH_TOKEN?.trim() || null,
  };
}
