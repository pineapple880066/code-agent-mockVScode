import { createHash } from "node:crypto";
import path from "node:path";

import { tokenize } from "./tokenize.js";
import type { CodeChunk } from "./types.js";

const MAX_CHUNK_LINES = 120;
const FALLBACK_CHUNK_LINES = 80;
const FALLBACK_OVERLAP = 20;

const LANGUAGE_PATTERNS: Array<{
  extensions: Set<string>;
  language: string;
  patterns: RegExp[];
}> = [
  {
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
    language: "typescript",
    patterns: [
      /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_]+)/,
      /^\s*(export\s+)?class\s+([A-Za-z0-9_]+)/,
      /^\s*(export\s+)?interface\s+([A-Za-z0-9_]+)/,
      /^\s*(export\s+)?type\s+([A-Za-z0-9_]+)/,
      /^\s*(export\s+)?(const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(async\s*)?\(/,
    ],
  },
  {
    extensions: new Set([".py"]),
    language: "python",
    patterns: [/^\s*(async\s+def|def)\s+([A-Za-z0-9_]+)/, /^\s*class\s+([A-Za-z0-9_]+)/],
  },
  {
    extensions: new Set([".go"]),
    language: "go",
    patterns: [/^\s*func\s+([A-Za-z0-9_]+)/, /^\s*type\s+([A-Za-z0-9_]+)/],
  },
  {
    extensions: new Set([".java", ".kt", ".swift", ".rs", ".rb", ".php", ".cs"]),
    language: "code",
    patterns: [/^\s*(class|struct|enum|interface|func|fn|def)\s+([A-Za-z0-9_]+)/],
  },
];

function detectLanguage(filePath: string): { language: string; patterns: RegExp[] } {
  const extension = path.extname(filePath).toLowerCase();

  for (const entry of LANGUAGE_PATTERNS) {
    if (entry.extensions.has(extension)) {
      return {
        language: entry.language,
        patterns: entry.patterns,
      };
    }
  }

  return {
    language: extension.replace(/^\./, "") || "text",
    patterns: [],
  };
}

function extractSymbol(line: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    const symbol = match.at(-1)?.trim();
    if (symbol) {
      return symbol;
    }
  }

  return undefined;
}

function makeChunk(filePath: string, language: string, lines: string[], startLine: number, endLine: number): CodeChunk {
  const text = lines.slice(startLine - 1, endLine).join("\n").trim();
  const { patterns } = detectLanguage(filePath);
  const symbol = extractSymbol(lines[startLine - 1] ?? "", patterns);
  const id = createHash("sha1").update(`${filePath}:${startLine}:${endLine}:${text}`).digest("hex");

  return {
    id,
    filePath,
    language,
    startLine,
    endLine,
    symbol,
    text,
    tokens: tokenize(`${filePath}\n${symbol ?? ""}\n${text}`),
  };
}

function fallbackChunks(filePath: string, language: string, lines: string[]): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  for (let start = 1; start <= lines.length; start += FALLBACK_CHUNK_LINES - FALLBACK_OVERLAP) {
    const end = Math.min(lines.length, start + FALLBACK_CHUNK_LINES - 1);
    const chunk = makeChunk(filePath, language, lines, start, end);
    if (chunk.text) {
      chunks.push(chunk);
    }
    if (end === lines.length) {
      break;
    }
  }

  return chunks;
}

export function chunkFile(filePath: string, content: string): CodeChunk[] {
  const lines = content.split(/\r?\n/);
  const { language, patterns } = detectLanguage(filePath);

  if (lines.length === 0) {
    return [];
  }

  const boundaries = new Set<number>([1]);
  for (let index = 0; index < lines.length; index += 1) {
    if (patterns.some((pattern) => pattern.test(lines[index] ?? ""))) {
      boundaries.add(index + 1);
    }
  }

  const ordered = Array.from(boundaries).sort((left, right) => left - right);
  if (ordered.length <= 1) {
    return fallbackChunks(filePath, language, lines);
  }

  const chunks: CodeChunk[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const startLine = ordered[index]!;
    const nextBoundary = ordered[index + 1] ?? lines.length + 1;
    let segmentStart = startLine;
    let segmentEnd = nextBoundary - 1;

    while (segmentStart <= segmentEnd) {
      const boundedEnd = Math.min(segmentEnd, segmentStart + MAX_CHUNK_LINES - 1);
      const chunk = makeChunk(filePath, language, lines, segmentStart, boundedEnd);
      if (chunk.text) {
        chunks.push(chunk);
      }
      segmentStart = boundedEnd + 1;
    }
  }

  return chunks.length > 0 ? chunks : fallbackChunks(filePath, language, lines);
}
