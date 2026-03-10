export type IndexStatus = {
  state: "idle" | "building" | "ready" | "error";
  lastBuiltAt?: string;
  fileCount: number;
  chunkCount: number;
  vectorEnabled: boolean;
  lastError?: string;
};

export type AppConfig = {
  workspaceRoot: string;
  model: string;
  authEnabled: boolean;
  index: IndexStatus;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};

export type FileResponse = {
  path: string;
  content: string;
};

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  score: number;
  keywordScore: number;
  vectorScore: number;
  preview: string;
};

export type SessionMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; content: string; name: string; toolCallId: string };

export type AgentStreamEvent =
  | { event: "status"; data: { message: string } }
  | { event: "tool_start"; data: { toolName: string; arguments: string } }
  | { event: "tool_end"; data: { toolName: string; result: string } }
  | { event: "assistant_delta"; data: { delta: string } }
  | { event: "done"; data: { reply: string; sessionId: string; steps: number } }
  | { event: "error"; data: { message: string } };
