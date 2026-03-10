import { access } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { Command } from "commander";

import { runAgentLoop } from "./agent/loop.js";
import { loadSession, resetSession, saveSession } from "./agent/session.js";
import { resolveChatConfig, resolveEmbeddingConfig, resolveWorkspaceRoot } from "./config.js";
import { OpenAICompatibleProvider } from "./llm/openai-compatible.js";
import { IndexManager } from "./rag/index-manager.js";
import { createToolRegistry } from "./tools/definitions.js";

const KNOWN_COMMANDS = new Set(["run", "repl", "tools", "index", "search", "help"]);

type SharedOptions = {
  workspace: string;
  session: string;
  model?: string;
  maxSteps: number;
  reset?: boolean;
};

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function addAgentOptions(command: Command): Command {
  return command
    .option("-w, --workspace <path>", "Workspace root", resolveWorkspaceRoot())
    .option("-s, --session <id>", "Session id", "main")
    .option("--model <name>", "Model override")
    .option("--max-steps <count>", "Maximum model/tool rounds", parseInteger, 6)
    .option("--reset", "Reset the session before running", false);
}

async function ensureWorkspace(workspaceRoot: string): Promise<void> {
  await access(workspaceRoot);
}

async function runTask(task: string, options: SharedOptions): Promise<void> {
  const workspaceRoot = path.resolve(options.workspace);
  await ensureWorkspace(workspaceRoot);

  if (options.reset) {
    await resetSession(workspaceRoot, options.session);
  }

  const session = await loadSession(workspaceRoot, options.session);
  const chatConfig = resolveChatConfig();
  const provider = new OpenAICompatibleProvider(chatConfig);
  const indexManager = new IndexManager(workspaceRoot, resolveEmbeddingConfig());
  await indexManager.initialize();
  const toolRegistry = createToolRegistry(workspaceRoot, indexManager);
  const model = options.model ?? chatConfig.model;

  const result = await runAgentLoop({
    provider,
    toolRegistry,
    indexManager,
    model,
    workspaceRoot,
    session,
    prompt: task,
    maxSteps: options.maxSteps,
    onEvent(event) {
      if (event.type === "status") {
        process.stderr.write(`\n[status] ${event.message}\n`);
      } else if (event.type === "tool_start") {
        process.stderr.write(`\n[tool] ${event.toolName} ${event.arguments}\n`);
      } else {
        process.stderr.write(`[tool] ${event.toolName} done\n`);
      }
    },
  });

  await saveSession(workspaceRoot, result.session);
  await indexManager.close();
  process.stdout.write(`${result.reply.trim()}\n`);
}

async function startRepl(options: SharedOptions): Promise<void> {
  const workspaceRoot = path.resolve(options.workspace);
  await ensureWorkspace(workspaceRoot);

  if (options.reset) {
    await resetSession(workspaceRoot, options.session);
  }

  const rl = readline.createInterface({ input, output });

  process.stdout.write(
    [
      `Workspace: ${workspaceRoot}`,
      `Session: ${options.session}`,
      "Commands: /reset, /exit, /help",
      "",
    ].join("\n"),
  );

  try {
    while (true) {
      const line = (await rl.question("code-agent> ")).trim();

      if (!line) {
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        break;
      }

      if (line === "/help") {
        process.stdout.write("Use natural-language coding tasks. Special commands: /reset, /exit\n");
        continue;
      }

      if (line === "/reset") {
        await resetSession(workspaceRoot, options.session);
        process.stdout.write("Session reset.\n");
        continue;
      }

      await runTask(line, options);
    }
  } finally {
    rl.close();
  }
}

export function normalizeArgv(argv: string[]): string[] {
  const firstArg = argv[2];

  if (!firstArg || firstArg.startsWith("-") || KNOWN_COMMANDS.has(firstArg)) {
    return argv;
  }

  return [argv[0]!, argv[1]!, "run", ...argv.slice(2)];
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("code-agent")
    .description("OpenClaw-inspired coding agent for a local workspace")
    .showHelpAfterError();

  addAgentOptions(
    program
      .command("run <task...>")
      .description("Run a one-shot coding task")
      .action(async (taskParts: string[], options: SharedOptions) => {
        await runTask(taskParts.join(" "), options);
      }),
  );

  addAgentOptions(
    program
      .command("repl")
      .description("Start an interactive coding-agent session")
      .action(async (options: SharedOptions) => {
        await startRepl(options);
      }),
  );

  program
    .command("tools")
    .description("List built-in tool definitions")
    .action(() => {
      const registry = createToolRegistry(resolveWorkspaceRoot());
      for (const tool of registry.specs) {
        process.stdout.write(`${tool.name}: ${tool.description}\n`);
      }
    });

  addAgentOptions(
    program
      .command("index")
      .description("Build or rebuild the local code index")
      .action(async (options: SharedOptions) => {
        const workspaceRoot = path.resolve(options.workspace);
        const indexManager = new IndexManager(workspaceRoot, resolveEmbeddingConfig());
        const status = await indexManager.rebuild();
        await indexManager.close();
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      }),
  );

  addAgentOptions(
    program
      .command("search <query...>")
      .description("Search the local code index")
      .action(async (queryParts: string[], options: SharedOptions) => {
        const workspaceRoot = path.resolve(options.workspace);
        const indexManager = new IndexManager(workspaceRoot, resolveEmbeddingConfig());
        await indexManager.initialize();
        const results = await indexManager.search({ query: queryParts.join(" "), limit: 8 });
        await indexManager.close();
        process.stdout.write(
          `${JSON.stringify(
            results.map((result) => ({
              path: result.chunk.filePath,
              startLine: result.chunk.startLine,
              endLine: result.chunk.endLine,
              symbol: result.chunk.symbol,
              score: result.score,
              keywordScore: result.keywordScore,
              vectorScore: result.vectorScore,
              preview: result.chunk.text,
            })),
            null,
            2,
          )}\n`,
        );
      }),
  );

  return program;
}
