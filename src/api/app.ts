import { existsSync } from "node:fs";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";

import { runAgentLoop } from "../agent/loop.js";
import { loadSession, resetSession, saveSession } from "../agent/session.js";
import type { ChatConfig, ServerConfig } from "../config.js";
import { OpenAICompatibleProvider } from "../llm/openai-compatible.js";
import type { IndexManager } from "../rag/index-manager.js";
import { createToolRegistry } from "../tools/definitions.js";
import {
  listWorkspaceDirectoryDetailed,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "../workspace/fs.js";

type CreateAppParams = {
  serverConfig: ServerConfig;
  chatConfig: ChatConfig;
  indexManager: IndexManager;
};

const REQUESTS_PER_MINUTE = 1000;

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createRateLimitMiddleware() {
  const requests = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "local";
    const now = Date.now();
    const windowStart = now - 60_000;
    const timestamps = (requests.get(key) ?? []).filter((timestamp) => timestamp >= windowStart);

    if (timestamps.length >= REQUESTS_PER_MINUTE) {
      res.status(429).json({ error: "Rate limit exceeded." });
      return;
    }

    timestamps.push(now);
    requests.set(key, timestamps);
    next();
  };
}

function createAuthMiddleware(authToken: string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) {
      next();
      return;
    }

    const rawHeader = req.header("authorization") ?? "";
    const token = rawHeader.startsWith("Bearer ") ? rawHeader.slice("Bearer ".length) : rawHeader;

    if (token === authToken) {
      next();
      return;
    }

    res.status(401).json({ error: "Unauthorized." });
  };
}

export function createApp(params: CreateAppParams) {
  const app = express();
  const provider = new OpenAICompatibleProvider(params.chatConfig);
  const staticRoot = path.resolve("web/dist");

  app.use(express.json({ limit: "4mb" }));
  app.use("/api", createRateLimitMiddleware());
  app.use("/api", createAuthMiddleware(params.serverConfig.authToken));

  app.get("/api/config", (_req, res) => {
    res.json({
      workspaceRoot: params.serverConfig.workspaceRoot,
      model: params.chatConfig.model,
      authEnabled: Boolean(params.serverConfig.authToken),
      index: params.indexManager.getStatus(),
    });
  });

  app.get("/api/index/status", (_req, res) => {
    res.json(params.indexManager.getStatus());
  });

  app.post("/api/index/rebuild", async (_req, res, next) => {
    try {
      const status = await params.indexManager.rebuild();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/search", async (req, res, next) => {
    try {
      const query = String(req.query.query ?? "").trim();
      const filePattern = String(req.query.filePattern ?? "").trim() || undefined;
      const limit = Number.parseInt(String(req.query.limit ?? "8"), 10) || 8;

      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const results = await params.indexManager.search({ query, filePattern, limit });
      res.json({
        results: results.map((result) => ({
          path: result.chunk.filePath,
          startLine: result.chunk.startLine,
          endLine: result.chunk.endLine,
          symbol: result.chunk.symbol,
          score: result.score,
          keywordScore: result.keywordScore,
          vectorScore: result.vectorScore,
          preview: result.chunk.text,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/files/list", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? ".") || ".";
      const entries = await listWorkspaceDirectoryDetailed(params.serverConfig.workspaceRoot, relativePath);
      res.json({
        path: relativePath,
        entries,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/files/content", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "").trim();
      if (!relativePath) {
        res.status(400).json({ error: "path is required" });
        return;
      }

      const file = await readWorkspaceTextFile(params.serverConfig.workspaceRoot, relativePath);
      res.json(file);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/files/content", async (req, res, next) => {
    try {
      const pathValue = String(req.body?.path ?? "").trim();
      const content = String(req.body?.content ?? "");

      if (!pathValue) {
        res.status(400).json({ error: "path is required" });
        return;
      }

      const saved = await writeWorkspaceTextFile(params.serverConfig.workspaceRoot, pathValue, content);
      await params.indexManager.rebuild();
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:sessionId", async (req, res, next) => {
    try {
      const session = await loadSession(params.serverConfig.workspaceRoot, req.params.sessionId);
      res.json(session);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/stream", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "main");
    const message = String(req.body?.message ?? "").trim();
    const maxSteps = Number.parseInt(String(req.body?.maxSteps ?? "6"), 10) || 6;
    const shouldReset = Boolean(req.body?.reset);

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    sendSse(res, "status", { message: "Session ready." });

    try {
      if (shouldReset) {
        await resetSession(params.serverConfig.workspaceRoot, sessionId);
        sendSse(res, "status", { message: "Session reset." });
      }

      const session = await loadSession(params.serverConfig.workspaceRoot, sessionId);
      const toolRegistry = createToolRegistry(params.serverConfig.workspaceRoot, params.indexManager);

      const result = await runAgentLoop({
        provider,
        toolRegistry,
        indexManager: params.indexManager,
        model: params.chatConfig.model,
        workspaceRoot: params.serverConfig.workspaceRoot,
        session,
        prompt: message,
        maxSteps,
        onEvent(event) {
          if (event.type === "status") {
            sendSse(res, "status", { message: event.message });
            return;
          }

          if (event.type === "tool_start") {
            sendSse(res, "tool_start", {
              toolName: event.toolName,
              arguments: event.arguments,
            });
            return;
          }

          sendSse(res, "tool_end", {
            toolName: event.toolName,
            result: event.result,
          });
        },
      });

      await saveSession(params.serverConfig.workspaceRoot, result.session);

      for (const chunk of result.reply.match(/.{1,120}(\s|$)/g) ?? [result.reply]) {
        sendSse(res, "assistant_delta", { delta: chunk });
      }

      sendSse(res, "done", {
        reply: result.reply,
        sessionId,
        steps: result.steps,
      });
    } catch (error) {
      sendSse(res, "error", { message: String(error) });
    } finally {
      res.end();
    }
  });

  if (existsSync(staticRoot)) {
    app.use(express.static(staticRoot));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(staticRoot, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return app;
}
