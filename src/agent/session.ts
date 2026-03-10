import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionMessage } from "./types.js";

export type SessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
};

const SESSION_DIR = path.join(".code-agent", "sessions");
const MAX_USER_TURNS = 8;

export function pruneSessionMessages(messages: SessionMessage[]): SessionMessage[] {
  let userTurns = 0;
  let startIndex = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userTurns += 1;
      if (userTurns > MAX_USER_TURNS) {
        startIndex = index + 1;
        break;
      }
    }
  }

  return messages.slice(startIndex);
}

export function sessionFilePath(workspaceRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(workspaceRoot, SESSION_DIR, `${safeId}.json`);
}

export async function loadSession(workspaceRoot: string, sessionId: string): Promise<SessionRecord> {
  const filePath = sessionFilePath(workspaceRoot, sessionId);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SessionRecord;
    return {
      ...parsed,
      id: parsed.id || sessionId,
      messages: Array.isArray(parsed.messages) ? pruneSessionMessages(parsed.messages) : [],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }

    const now = new Date().toISOString();
    return {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }
}

export async function saveSession(workspaceRoot: string, session: SessionRecord): Promise<void> {
  const filePath = sessionFilePath(workspaceRoot, session.id);
  await mkdir(path.dirname(filePath), { recursive: true });

  const now = new Date().toISOString();
  const next: SessionRecord = {
    ...session,
    updatedAt: now,
    messages: pruneSessionMessages(session.messages),
  };

  await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
}

export async function resetSession(workspaceRoot: string, sessionId: string): Promise<void> {
  await rm(sessionFilePath(workspaceRoot, sessionId), { force: true });
}
