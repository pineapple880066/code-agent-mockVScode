import { tokenize } from "./tokenize.js";
import type { CodeChunk, SearchResult } from "./types.js";

type Bm25Stats = {
  avgDocLength: number;
  documentFrequency: Map<string, number>;
  documents: number;
};

const TEXT_WEIGHT = 0.3;
const VECTOR_WEIGHT = 0.7;
const RRF_K = 60;

function buildBm25Stats(chunks: CodeChunk[]): Bm25Stats {
  const documentFrequency = new Map<string, number>();

  for (const chunk of chunks) {
    const uniqueTerms = new Set(chunk.tokens);
    for (const term of uniqueTerms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0);

  return {
    avgDocLength: chunks.length > 0 ? totalLength / chunks.length : 0,
    documentFrequency,
    documents: chunks.length,
  };
}

function scoreBm25(queryTokens: string[], chunk: CodeChunk, stats: Bm25Stats): number {
  if (chunk.tokens.length === 0 || queryTokens.length === 0 || stats.avgDocLength === 0) {
    return 0;
  }

  const termCounts = new Map<string, number>();
  for (const token of chunk.tokens) {
    termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
  }

  let score = 0;
  const k1 = 1.5;
  const b = 0.75;

  for (const token of queryTokens) {
    const termFrequency = termCounts.get(token) ?? 0;
    if (termFrequency === 0) {
      continue;
    }

    const documentFrequency = stats.documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (stats.documents - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const denominator = termFrequency + k1 * (1 - b + (b * chunk.tokens.length) / stats.avgDocLength);
    score += idf * ((termFrequency * (k1 + 1)) / denominator);
  }

  return score;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function addReciprocalRankScores(
  scores: Map<string, { keywordScore: number; vectorScore: number; rrf: number }>,
  rankedIds: string[],
  kind: "keyword" | "vector",
): void {
  rankedIds.forEach((id, index) => {
    const current = scores.get(id) ?? { keywordScore: 0, vectorScore: 0, rrf: 0 };
    current.rrf += (kind === "vector" ? VECTOR_WEIGHT : TEXT_WEIGHT) * (1 / (RRF_K + index + 1));
    scores.set(id, current);
  });
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`);
}

export function searchChunks(params: {
  chunks: CodeChunk[];
  query: string;
  queryEmbedding?: number[];
  filePattern?: string;
  limit: number;
}): SearchResult[] {
  const queryTokens = tokenize(params.query);
  const bm25Stats = buildBm25Stats(params.chunks);
  const fileMatcher = params.filePattern ? patternToRegExp(params.filePattern) : null;
  const candidates = params.chunks.filter((chunk) => !fileMatcher || fileMatcher.test(chunk.filePath));

  const keywordRanked = candidates
    .map((chunk) => ({
      id: chunk.id,
      score: scoreBm25(queryTokens, chunk, bm25Stats),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const vectorRanked =
    params.queryEmbedding && params.queryEmbedding.length > 0
      ? candidates
          .map((chunk) => ({
            id: chunk.id,
            score: cosineSimilarity(params.queryEmbedding!, chunk.embedding ?? []),
          }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score)
      : [];

  const mergedScores = new Map<string, { keywordScore: number; vectorScore: number; rrf: number }>();

  for (const entry of keywordRanked) {
    const current = mergedScores.get(entry.id) ?? { keywordScore: 0, vectorScore: 0, rrf: 0 };
    current.keywordScore = entry.score;
    mergedScores.set(entry.id, current);
  }

  for (const entry of vectorRanked) {
    const current = mergedScores.get(entry.id) ?? { keywordScore: 0, vectorScore: 0, rrf: 0 };
    current.vectorScore = entry.score;
    mergedScores.set(entry.id, current);
  }

  addReciprocalRankScores(
    mergedScores,
    keywordRanked.map((entry) => entry.id),
    "keyword",
  );
  addReciprocalRankScores(
    mergedScores,
    vectorRanked.map((entry) => entry.id),
    "vector",
  );

  const chunkMap = new Map(candidates.map((chunk) => [chunk.id, chunk]));

  return Array.from(mergedScores.entries())
    .map(([id, score]) => ({
      chunk: chunkMap.get(id)!,
      score: score.rrf,
      keywordScore: score.keywordScore,
      vectorScore: score.vectorScore,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, params.limit);
}
