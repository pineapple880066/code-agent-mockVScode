import assert from "node:assert/strict";
import test from "node:test";

import { chunkFile } from "./chunker.js";

test("chunkFile splits TypeScript declarations into semantic chunks", () => {
  const chunks = chunkFile(
    "src/example.ts",
    [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return 2;",
      "}",
    ].join("\n"),
  );

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.symbol, "alpha");
  assert.equal(chunks[1]?.symbol, "beta");
});
