import type {
  AgentStreamEvent,
  AppConfig,
  DirectoryEntry,
  FileResponse,
  IndexStatus,
  SearchResult,
  SessionMessage,
} from "./types";

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

export function getConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>("/api/config");
}

export async function getDirectory(path = "."): Promise<{ path: string; entries: DirectoryEntry[] }> {
  return fetchJson(`/api/files/list?path=${encodeURIComponent(path)}`);
}

export function getFile(path: string): Promise<FileResponse> {
  return fetchJson(`/api/files/content?path=${encodeURIComponent(path)}`);
}

export function saveFile(path: string, content: string): Promise<{ path: string }> {
  return fetchJson("/api/files/content", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, content }),
  });
}

export async function getSearchResults(query: string, limit = 8): Promise<SearchResult[]> {
  const payload = await fetchJson<{ results: SearchResult[] }>(
    `/api/search?query=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return payload.results;
}

export function rebuildIndex(): Promise<IndexStatus> {
  return fetchJson("/api/index/rebuild", {
    method: "POST",
  });
}

export function getIndexStatus(): Promise<IndexStatus> {
  return fetchJson("/api/index/status");
}

export async function getSession(sessionId: string): Promise<{ id: string; messages: SessionMessage[] }> {
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function streamAgent(
  payload: {
    message: string;
    sessionId: string;
    maxSteps?: number;
    reset?: boolean;
  },
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/agent/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const eventName = rawEvent
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace("data:", "")
        .trim();

      if (!eventName || !dataLine) {
        continue;
      }

      onEvent({
        event: eventName as AgentStreamEvent["event"],
        data: JSON.parse(dataLine) as AgentStreamEvent["data"],
      } as AgentStreamEvent);
    }
  }
}
