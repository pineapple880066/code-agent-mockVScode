import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createToolRegistry } from "./definitions.js";

test("edit_file updates exactly one match", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  const filePath = path.join(workspaceRoot, "example.ts");
  await writeFile(filePath, "const value = 1;\n", "utf8");

  const tools = createToolRegistry(workspaceRoot);
  const result = await tools.execute({
    id: "tool-1",
    name: "edit_file",
    arguments: JSON.stringify({
      path: "example.ts",
      oldText: "value = 1",
      newText: "value = 2",
    }),
  });

  assert.match(result, /"ok": true/);
  assert.equal(await readFile(filePath, "utf8"), "const value = 2;\n");
});

test("edit_file rejects ambiguous matches", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  await writeFile(path.join(workspaceRoot, "example.ts"), "foo\nfoo\n", "utf8");

  const tools = createToolRegistry(workspaceRoot);
  const result = await tools.execute({
    id: "tool-2",
    name: "edit_file",
    arguments: JSON.stringify({
      path: "example.ts",
      oldText: "foo",
      newText: "bar",
    }),
  });

  assert.match(result, /multiple locations/);
});

test("write_file stays inside the workspace boundary", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  const tools = createToolRegistry(workspaceRoot);

  const result = await tools.execute({
    id: "tool-3",
    name: "write_file",
    arguments: JSON.stringify({
      path: "../escape.txt",
      content: "nope",
    }),
  });

  assert.match(result, /escapes workspace/);
});
