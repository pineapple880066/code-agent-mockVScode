export type CodeChunk = {
  id: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  text: string;
  tokens: string[];
  embedding?: number[];
};

export type SearchResult = {
  chunk: CodeChunk;
  score: number;
  keywordScore: number;
  vectorScore: number;
};

export type IndexSnapshot = {
  builtAt: string;
  vectorEnabled: boolean;
  chunks: CodeChunk[];
};

export type IndexStatus = {
  state: "idle" | "building" | "ready" | "error";
  lastBuiltAt?: string;
  fileCount: number;
  chunkCount: number;
  vectorEnabled: boolean;
  lastError?: string;
};
