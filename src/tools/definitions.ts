import { exec, execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";
import { z } from "zod";

import type { ToolCall, ToolSpec } from "../agent/types.js";
import type { IndexManager } from "../rag/index-manager.js";
import {
  listWorkspaceDirectory,
  relativeToWorkspace,
  resolveWorkspacePath,
  SEARCH_IGNORE,
} from "../workspace/fs.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_READ_LIMIT = 250;
const MAX_GLOB_RESULTS = 200;

type ToolContext = {
  workspaceRoot: string;
  indexManager?: IndexManager;
};

type ToolPayload = {
  ok: boolean;
  summary: string;
  content?: string;
  items?: string[];
  path?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

type ToolDefinition<TInput> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: (value: unknown) => TInput;
  execute: (input: TInput, context: ToolContext) => Promise<ToolPayload>;
};

export type ToolRegistry = {
  specs: ToolSpec[];
  execute(toolCall: ToolCall): Promise<string>;
};

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...<truncated>`;
}

function serialize(payload: ToolPayload): string {
  return truncate(JSON.stringify(payload, null, 2));
}

async function fallbackSearch(workspaceRoot: string, query: string, filePattern: string | undefined, limit: number): Promise<string[]> {
  const entries = await fg(filePattern ? [filePattern] : ["**/*"], {
    cwd: workspaceRoot,
    dot: true,
    ignore: SEARCH_IGNORE,
    onlyFiles: true,
  });

  const matches: string[] = [];

  for (const relativeFile of entries) {
    if (matches.length >= limit) {
      break;
    }

    const absoluteFile = path.join(workspaceRoot, relativeFile);
    let raw = "";

    try {
      raw = await readFile(absoluteFile, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.includes(query)) {
        matches.push(`${relativeFile}:${index + 1}:${lines[index]}`);
        if (matches.length >= limit) {
          break;
        }
      }
    }
  }

  return matches;
}

async function runCommand(command: string, cwd: string, timeout: number): Promise<ToolPayload> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      shell: process.env.SHELL ?? "/bin/zsh",
    });

    return {
      ok: true,
      summary: "Command completed successfully.",
      exitCode: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
    };
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
    };

    return {
      ok: false,
      summary: typedError.killed ? "Command timed out." : "Command exited with a non-zero status.",
      exitCode: typeof typedError.code === "number" ? typedError.code : undefined,
      stdout: truncate(typedError.stdout ?? ""),
      stderr: truncate(typedError.stderr ?? String(error)),
    };
  }
}

const readFileTool: ToolDefinition<{
  path: string;
  offset?: number;
  limit?: number;
}> = {
  name: "read_file",
  description: "Read a text file from the workspace with optional line offset and limit.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    required: ["path"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
    const raw = await readFile(targetPath, "utf8");
    const lines = raw.split(/\r?\n/);
    const startLine = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const selected = lines.slice(startLine - 1, startLine - 1 + limit);
    const numbered = selected.map((line, index) => `${startLine + index} | ${line}`).join("\n");

    return {
      ok: true,
      summary: `Read ${selected.length} line(s) from ${relativeToWorkspace(context.workspaceRoot, targetPath)}.`,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
      content: truncate(numbered),
    };
  },
};

const writeFileTool: ToolDefinition<{
  path: string;
  content: string;
}> = {
  name: "write_file",
  description: "Create or overwrite a file in the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
        content: z.string(),
      })
      .parse(value),
  execute: async (input, context) => {
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, input.content, "utf8");
    const fileStats = await stat(targetPath);

    return {
      ok: true,
      summary: `Wrote ${fileStats.size} byte(s) to ${relativeToWorkspace(context.workspaceRoot, targetPath)}.`,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
    };
  },
};

const editFileTool: ToolDefinition<{
  path: string;
  oldText: string;
  newText: string;
}> = {
  name: "edit_file",
  description: "Edit a file by replacing one exact text occurrence.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    required: ["path", "oldText", "newText"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
      })
      .parse(value),
  execute: async (input, context) => {
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
    const current = await readFile(targetPath, "utf8");
    const occurrences = current.split(input.oldText).length - 1;

    if (occurrences === 0) {
      throw new Error("oldText was not found in the target file.");
    }

    if (occurrences > 1) {
      throw new Error("oldText matched multiple locations. Use a more specific snippet.");
    }

    const updated = current.replace(input.oldText, input.newText);
    await writeFile(targetPath, updated, "utf8");

    return {
      ok: true,
      summary: `Updated ${relativeToWorkspace(context.workspaceRoot, targetPath)} with one exact replacement.`,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
    };
  },
};

const searchCodeTool: ToolDefinition<{
  query: string;
  filePattern?: string;
  limit?: number;
}> = {
  name: "search_code",
  description: "Search code using the indexed hybrid search, optionally constrained by a glob pattern.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      filePattern: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["query"],
  },
  parse: (value) =>
    z
      .object({
        query: z.string().min(1),
        filePattern: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const limit = input.limit ?? 20;
    if (context.indexManager) {
      const results = await context.indexManager.search({
        query: input.query,
        filePattern: input.filePattern,
        limit,
      });

      const formatted = results.map(
        (result) =>
          `${result.chunk.filePath}:${result.chunk.startLine}-${result.chunk.endLine} score=${result.score.toFixed(4)}\n${result.chunk.text}`,
      );

      return {
        ok: true,
        summary: formatted.length > 0 ? `Found ${formatted.length} indexed match(es).` : "No indexed matches found.",
        items: formatted,
        content: formatted.join("\n\n"),
      };
    }

    let lines: string[] = [];

    try {
      const args = ["-n", "--no-heading", "--color", "never", "-F", input.query];
      if (input.filePattern) {
        args.push("-g", input.filePattern);
      }
      args.push(".");

      const { stdout } = await execFileAsync("rg", args, {
        cwd: context.workspaceRoot,
        maxBuffer: 1024 * 1024,
      });

      lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
      const errorCode = typedError.code !== undefined ? String(typedError.code) : undefined;

      if (errorCode === "1") {
        lines = [];
      } else if (errorCode === "ENOENT") {
        lines = await fallbackSearch(context.workspaceRoot, input.query, input.filePattern, limit);
      } else {
        throw error;
      }
    }

    return {
      ok: true,
      summary: lines.length > 0 ? `Found ${lines.length} match(es).` : "No matches found.",
      items: lines,
      content: lines.join("\n"),
    };
  },
};

const listDirectoryTool: ToolDefinition<{
  path: string;
}> = {
  name: "list_directory",
  description: "List files and directories for a path inside the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
      })
      .parse(value),
  execute: async (input, context) => {
    const items = await listWorkspaceDirectory(context.workspaceRoot, input.path);
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);

    return {
      ok: true,
      summary: `Listed ${items.length} item(s) from ${relativeToWorkspace(context.workspaceRoot, targetPath)}.`,
      items,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
      content: items.join("\n"),
    };
  },
};

const globTool: ToolDefinition<{
  pattern: string;
  root?: string;
}> = {
  name: "glob",
  description: "Find files or directories by glob pattern inside the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      root: { type: "string" },
    },
    required: ["pattern"],
  },
  parse: (value) =>
    z
      .object({
        pattern: z.string().min(1),
        root: z.string().optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const searchRoot = input.root
      ? await resolveWorkspacePath(context.workspaceRoot, input.root)
      : context.workspaceRoot;

    const matches = await fg([input.pattern], {
      cwd: searchRoot,
      dot: true,
      ignore: SEARCH_IGNORE,
      onlyFiles: false,
    });

    const normalized = matches
      .slice(0, MAX_GLOB_RESULTS)
      .map((match) => relativeToWorkspace(context.workspaceRoot, path.join(searchRoot, match)));

    return {
      ok: true,
      summary: normalized.length > 0 ? `Found ${normalized.length} path(s).` : "No matches found.",
      items: normalized,
      content: normalized.join("\n"),
    };
  },
};

const executeCommandTool: ToolDefinition<{
  command: string;
  cwd?: string;
  timeout?: number;
}> = {
  name: "execute_command",
  description: "Run a shell command inside the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeout: { type: "integer", minimum: 100, maximum: 120000 },
    },
    required: ["command"],
  },
  parse: (value) =>
    z
      .object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeout: z.number().int().min(100).max(120_000).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const cwd = input.cwd
      ? await resolveWorkspacePath(context.workspaceRoot, input.cwd)
      : context.workspaceRoot;

    return runCommand(input.command, cwd, input.timeout ?? 30_000);
  },
};

const definitions: ToolDefinition<unknown>[] = [
  readFileTool as ToolDefinition<unknown>,
  writeFileTool as ToolDefinition<unknown>,
  editFileTool as ToolDefinition<unknown>,
  searchCodeTool as ToolDefinition<unknown>,
  listDirectoryTool as ToolDefinition<unknown>,
  globTool as ToolDefinition<unknown>,
  executeCommandTool as ToolDefinition<unknown>,
];

export function createToolRegistry(workspaceRoot: string, indexManager?: IndexManager): ToolRegistry {
  const context: ToolContext = { workspaceRoot, indexManager };
  const definitionMap = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    specs: definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
    async execute(toolCall) {
      const definition = definitionMap.get(toolCall.name);

      if (!definition) {
        return serialize({
          ok: false,
          summary: `Unknown tool: ${toolCall.name}`,
        });
      }

      try {
        const args = JSON.parse(toolCall.arguments);
        const input = definition.parse(args);
        const result = await definition.execute(input, context);
        return serialize(result);
      } catch (error) {
        return serialize({
          ok: false,
          summary: `Tool ${toolCall.name} failed.`,
          content: String(error),
        });
      }
    },
  };
}
