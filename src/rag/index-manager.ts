import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import type { EmbeddingConfig } from "../config.js";
import { EmbeddingClient } from "./embeddings.js";
import { chunkFile } from "./chunker.js";
import { searchChunks } from "./hybrid-search.js";
import type { CodeChunk, IndexSnapshot, IndexStatus, SearchResult } from "./types.js";
import { collectWorkspaceFiles, looksLikeTextFile, readWorkspaceTextFile, SEARCH_IGNORE } from "../workspace/fs.js";

const INDEX_FILE = path.join(".code-agent", "index", "snapshot.json");
const MAX_INDEXED_FILE_BYTES = 300_000;

function summarizeChunk(chunk: CodeChunk): string {
  const header = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}${chunk.symbol ? ` ${chunk.symbol}` : ""}`;
  return `${header}\n${chunk.text}`;
}

export class IndexManager {
  readonly #workspaceRoot: string;
  readonly #embeddingClient: EmbeddingClient;
  #snapshot: IndexSnapshot = {
    builtAt: "",
    vectorEnabled: false,
    chunks: [],
  };
  #status: IndexStatus = {
    state: "idle",
    fileCount: 0,
    chunkCount: 0,
    vectorEnabled: false,
  };
  #watcher: FSWatcher | null = null;
  #rebuildTimer: NodeJS.Timeout | null = null;

  constructor(workspaceRoot: string, embeddingConfig: EmbeddingConfig) {
    this.#workspaceRoot = workspaceRoot;
    this.#embeddingClient = new EmbeddingClient(embeddingConfig);
  }

  async initialize(): Promise<void> {
    await this.loadSnapshot();
    if (this.#snapshot.chunks.length === 0) {
      await this.rebuild();
    }
  }

  getStatus(): IndexStatus {
    return { ...this.#status };
  }

  async loadSnapshot(): Promise<void> {
    try {
      const raw = await readFile(path.join(this.#workspaceRoot, INDEX_FILE), "utf8");
      const snapshot = JSON.parse(raw) as IndexSnapshot;
      this.#snapshot = snapshot;
      this.#status = {
        state: "ready",
        lastBuiltAt: snapshot.builtAt,
        fileCount: new Set(snapshot.chunks.map((chunk) => chunk.filePath)).size,
        chunkCount: snapshot.chunks.length,
        vectorEnabled: snapshot.vectorEnabled,
      };
    } catch {
      // Snapshot is optional on first boot.
    }
  }

  async rebuild(): Promise<IndexStatus> {
    this.#status = {
      ...this.#status,
      state: "building",
      lastError: undefined,
    };

    try {
      const files = await collectWorkspaceFiles(this.#workspaceRoot);
      const chunks: CodeChunk[] = [];

      for (const relativePath of files) {
        if (!looksLikeTextFile(relativePath)) {
          continue;
        }

        const file = await readWorkspaceTextFile(this.#workspaceRoot, relativePath);
        if (Buffer.byteLength(file.content, "utf8") > MAX_INDEXED_FILE_BYTES) {
          continue;
        }
        chunks.push(...chunkFile(relativePath, file.content));
      }

      if (this.#embeddingClient.isEnabled() && chunks.length > 0) {
        const batchSize = 10;
        for (let offset = 0; offset < chunks.length; offset += batchSize) {
          const batch = chunks.slice(offset, offset + batchSize);
          const embeddings = await this.#embeddingClient.embedTexts(batch.map((chunk) => summarizeChunk(chunk)));
          batch.forEach((chunk, index) => {
            chunk.embedding = embeddings[index];
          });
        }
      }

      this.#snapshot = {
        builtAt: new Date().toISOString(),
        vectorEnabled: this.#embeddingClient.isEnabled(),
        chunks,
      };

      await mkdir(path.dirname(path.join(this.#workspaceRoot, INDEX_FILE)), { recursive: true });
      await writeFile(
        path.join(this.#workspaceRoot, INDEX_FILE),
        JSON.stringify(this.#snapshot, null, 2),
        "utf8",
      );

      this.#status = {
        state: "ready",
        lastBuiltAt: this.#snapshot.builtAt,
        fileCount: new Set(chunks.map((chunk) => chunk.filePath)).size,
        chunkCount: chunks.length,
        vectorEnabled: this.#snapshot.vectorEnabled,
      };
      return this.getStatus();
    } catch (error) {
      this.#status = {
        ...this.#status,
        state: "error",
        lastError: String(error),
      };
      throw error;
    }
  }

  async search(params: {
    query: string;
    filePattern?: string;
    limit?: number;
  }): Promise<SearchResult[]> {
    if (this.#snapshot.chunks.length === 0) {
      await this.rebuild();
    }

    const limit = params.limit ?? 8;
    const queryEmbedding =
      this.#embeddingClient.isEnabled() && params.query.trim()
        ? (await this.#embeddingClient.embedTexts([params.query]))[0]
        : undefined;

    return searchChunks({
      chunks: this.#snapshot.chunks,
      query: params.query,
      queryEmbedding,
      filePattern: params.filePattern,
      limit,
    });
  }

  async retrieveContext(query: string, limit = 6): Promise<string> {
    const results = await this.search({ query, limit });
    if (results.length === 0) {
      return "";
    }

    return results
      .map(
        (result, index) =>
          `[Context ${index + 1}] ${result.chunk.filePath}:${result.chunk.startLine}-${result.chunk.endLine}\n${result.chunk.text}`,
      )
      .join("\n\n");
  }

  startWatching(): void {
    if (this.#watcher) {
      return;
    }

    this.#watcher = chokidar.watch(this.#workspaceRoot, {
      ignored: SEARCH_IGNORE,
      ignoreInitial: true,
    });

    const scheduleRebuild = () => {
      if (this.#rebuildTimer) {
        clearTimeout(this.#rebuildTimer);
      }
      this.#rebuildTimer = setTimeout(() => {
        void this.rebuild().catch(() => {
          // Status is updated inside rebuild.
        });
      }, 500);
    };

    this.#watcher.on("add", scheduleRebuild);
    this.#watcher.on("change", scheduleRebuild);
    this.#watcher.on("unlink", scheduleRebuild);
  }

  async close(): Promise<void> {
    if (this.#rebuildTimer) {
      clearTimeout(this.#rebuildTimer);
    }
    await this.#watcher?.close();
    this.#watcher = null;
  }
}
