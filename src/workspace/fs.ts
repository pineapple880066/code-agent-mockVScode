import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

export const SEARCH_IGNORE = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/web/dist/**", "**/.code-agent/**"];
export type DirectoryEntryInfo = {
  name: string;
  path: string;
  kind: "file" | "directory";
};
const TEXT_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);
const HIDDEN_ENTRY_NAMES = new Set([".code-agent", ".git", "dist", "node_modules"]);

async function resolveExistingAncestor(targetPath: string): Promise<string> {
  let current = targetPath;

  while (true) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export async function resolveWorkspacePath(workspaceRoot: string, candidatePath: string): Promise<string> {
  const rootRealPath = await realpath(workspaceRoot);
  const absolutePath = path.resolve(workspaceRoot, candidatePath);
  const probePath = await resolveExistingAncestor(absolutePath);
  const probeRealPath = await realpath(probePath);
  const relativeProbe = path.relative(rootRealPath, probeRealPath);

  if (relativeProbe.startsWith("..") || path.isAbsolute(relativeProbe)) {
    throw new Error(`Path escapes workspace: ${candidatePath}`);
  }

  return absolutePath;
}

export function relativeToWorkspace(workspaceRoot: string, absolutePath: string): string {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return relativePath || ".";
}

export function looksLikeTextFile(filePath: string): boolean {
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function collectWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  return fg(["**/*"], {
    cwd: workspaceRoot,
    dot: true,
    ignore: SEARCH_IGNORE,
    onlyFiles: true,
  });
}

export async function listWorkspaceDirectory(workspaceRoot: string, relativePath: string): Promise<string[]> {
  const items = await listWorkspaceDirectoryDetailed(workspaceRoot, relativePath);
  return items.map((entry) => `${entry.kind === "directory" ? "DIR " : "FILE"} ${entry.name}`);
}

export async function listWorkspaceDirectoryDetailed(
  workspaceRoot: string,
  relativePath: string,
): Promise<DirectoryEntryInfo[]> {
  const targetPath = await resolveWorkspacePath(workspaceRoot, relativePath);
  const entries = await readdir(targetPath, { withFileTypes: true });

  return entries
    .filter((entry) => !HIDDEN_ENTRY_NAMES.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.posix.join(relativePath === "." ? "" : relativePath, entry.name) || entry.name,
      kind: (entry.isDirectory() ? "directory" : "file") as "file" | "directory",
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export async function readWorkspaceTextFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<{ path: string; content: string }> {
  const absolutePath = await resolveWorkspacePath(workspaceRoot, relativePath);
  const content = await readFile(absolutePath, "utf8");
  return {
    path: relativeToWorkspace(workspaceRoot, absolutePath),
    content,
  };
}

export async function writeWorkspaceTextFile(
  workspaceRoot: string,
  relativePath: string,
  content: string,
): Promise<{ path: string }> {
  const absolutePath = await resolveWorkspacePath(workspaceRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return {
    path: relativeToWorkspace(workspaceRoot, absolutePath),
  };
}
