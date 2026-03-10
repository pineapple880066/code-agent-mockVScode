import Editor from "@monaco-editor/react";
import { startTransition, useDeferredValue, useEffect, useState } from "react";

import { getConfig, getDirectory, getFile, getIndexStatus, getSearchResults, getSession, rebuildIndex, saveFile, streamAgent } from "./api";
import type { AppConfig, DirectoryEntry, SearchResult, SessionMessage } from "./types";

const SESSION_ID = "main";

type ActivityItem =
  | { kind: "status"; text: string }
  | { kind: "tool_start"; text: string }
  | { kind: "tool_end"; text: string };

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [openFilePath, setOpenFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [sessionMessages, setSessionMessages] = useState<SessionMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const deferredSearch = useDeferredValue(searchInput);

  async function loadDirectory(targetPath: string) {
    const payload = await getDirectory(targetPath);
    setCurrentPath(payload.path);
    startTransition(() => {
      setEntries(payload.entries);
    });
  }

  async function loadFile(targetPath: string) {
    const file = await getFile(targetPath);
    setOpenFilePath(file.path);
    setFileContent(file.content);
    setDraftContent(file.content);
  }

  useEffect(() => {
    void (async () => {
      try {
        const [configPayload, sessionPayload] = await Promise.all([getConfig(), getSession(SESSION_ID)]);
        setConfig(configPayload);
        setSessionMessages(sessionPayload.messages);
        await loadDirectory(".");
      } catch (caughtError) {
        setError(String(caughtError));
      }
    })();
  }, []);

  useEffect(() => {
    if (!deferredSearch.trim()) {
      setSearchResults([]);
      return;
    }

    void (async () => {
      try {
        const results = await getSearchResults(deferredSearch.trim());
        startTransition(() => {
          setSearchResults(results);
        });
      } catch (caughtError) {
        setError(String(caughtError));
      }
    })();
  }, [deferredSearch]);

  const isDirty = openFilePath !== "" && draftContent !== fileContent;

  async function handleSave() {
    if (!openFilePath) {
      return;
    }

    try {
      setIsSaving(true);
      setError("");
      await saveFile(openFilePath, draftContent);
      setFileContent(draftContent);
      const nextStatus = await getIndexStatus();
      setConfig((current) => (current ? { ...current, index: nextStatus } : current));
    } catch (caughtError) {
      setError(String(caughtError));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRebuildIndex() {
    try {
      setError("");
      const status = await rebuildIndex();
      setConfig((current) => (current ? { ...current, index: status } : current));
    } catch (caughtError) {
      setError(String(caughtError));
    }
  }

  async function handleSend() {
    if (!chatInput.trim() || isSending) {
      return;
    }

    const prompt = chatInput.trim();
    setChatInput("");
    setIsSending(true);
    setError("");
    setActivity([]);
    setSessionMessages((current) => [...current, { role: "user", content: prompt }, { role: "assistant", content: "" }]);

    try {
      await streamAgent(
        {
          message: prompt,
          sessionId: SESSION_ID,
        },
        (event) => {
          if (event.event === "status") {
            setActivity((current) => [...current, { kind: "status", text: event.data.message }]);
            return;
          }

          if (event.event === "tool_start") {
            setActivity((current) => [
              ...current,
              { kind: "tool_start", text: `${event.data.toolName} ${event.data.arguments}` },
            ]);
            return;
          }

          if (event.event === "tool_end") {
            setActivity((current) => [...current, { kind: "tool_end", text: `${event.data.toolName} finished` }]);
            return;
          }

          if (event.event === "assistant_delta") {
            setSessionMessages((current) => {
              const next = [...current];
              const last = next.at(-1);
              if (last?.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  content: `${last.content}${event.data.delta}`,
                };
              }
              return next;
            });
            return;
          }

          if (event.event === "done") {
            void getSession(SESSION_ID).then((session) => {
              startTransition(() => {
                setSessionMessages(session.messages);
              });
            });
            return;
          }

          setError(event.data.message);
        },
      );
    } catch (caughtError) {
      setError(String(caughtError));
    } finally {
      setIsSending(false);
      const nextStatus = await getIndexStatus().catch(() => null);
      if (nextStatus) {
        setConfig((current) => (current ? { ...current, index: nextStatus } : current));
      }
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Code Agent</p>
          <h1>Workspace-native coding agent</h1>
        </div>
        <div className="status-strip">
          <span className={`pill pill-${config?.index.state ?? "idle"}`}>Index: {config?.index.state ?? "loading"}</span>
          <span className="pill">Model: {config?.model ?? "..."}</span>
          <span className="pill">Vectors: {config?.index.vectorEnabled ? "on" : "off"}</span>
          <button className="secondary-button" onClick={handleRebuildIndex}>
            Rebuild Index
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <main className="workspace-grid">
        <section className="panel sidebar-panel">
          <div className="panel-header">
            <div>
              <p className="panel-title">Files</p>
              <p className="panel-subtitle">{currentPath}</p>
            </div>
            {currentPath !== "." ? (
              <button
                className="secondary-button"
                onClick={() => {
                  const parent = currentPath.includes("/") ? currentPath.split("/").slice(0, -1).join("/") : ".";
                  void loadDirectory(parent || ".");
                }}
              >
                Up
              </button>
            ) : null}
          </div>

          <div className="file-list">
            {entries.map((entry) => (
              <button
                key={entry.path}
                className={`file-row ${openFilePath === entry.path ? "active" : ""}`}
                onClick={() => {
                  if (entry.kind === "directory") {
                    void loadDirectory(entry.path);
                  } else {
                    void loadFile(entry.path);
                  }
                }}
              >
                <span className="file-kind">{entry.kind === "directory" ? "DIR" : "FILE"}</span>
                <span>{entry.name}</span>
              </button>
            ))}
          </div>

          <div className="search-card">
            <p className="panel-title">Indexed Search</p>
            <input
              className="text-input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search symbols, code, or concepts"
            />
            <div className="search-results">
              {searchResults.map((result) => (
                <button
                  key={`${result.path}:${result.startLine}`}
                  className="search-result"
                  onClick={() => {
                    void loadFile(result.path);
                  }}
                >
                  <strong>{result.path}</strong>
                  <span>
                    {result.startLine}-{result.endLine}
                    {result.symbol ? ` · ${result.symbol}` : ""}
                  </span>
                  <p>{result.preview.slice(0, 180)}</p>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel editor-panel">
          <div className="panel-header">
            <div>
              <p className="panel-title">Editor</p>
              <p className="panel-subtitle">{openFilePath || "Select a file"}</p>
            </div>
            <button className="primary-button" disabled={!isDirty || isSaving} onClick={handleSave}>
              {isSaving ? "Saving..." : isDirty ? "Save File" : "Saved"}
            </button>
          </div>

          <div className="editor-frame">
            <Editor
              height="100%"
              path={openFilePath || "untitled.ts"}
              value={draftContent}
              onChange={(value) => setDraftContent(value ?? "")}
              theme="vs"
              options={{
                fontFamily: "JetBrains Mono, ui-monospace, monospace",
                fontSize: 14,
                minimap: { enabled: false },
                smoothScrolling: true,
                automaticLayout: true,
              }}
            />
          </div>
        </section>

        <section className="panel chat-panel">
          <div className="panel-header">
            <div>
              <p className="panel-title">Agent</p>
              <p className="panel-subtitle">Session: {SESSION_ID}</p>
            </div>
          </div>

          <div className="activity-list">
            {activity.map((item, index) => (
              <div key={`${item.kind}-${index}`} className={`activity-pill activity-${item.kind}`}>
                {item.text}
              </div>
            ))}
          </div>

          <div className="chat-history">
            {sessionMessages.map((message, index) => (
              <article key={`${message.role}-${index}`} className={`message message-${message.role}`}>
                <div className="message-role">{message.role}</div>
                <pre>{message.content}</pre>
              </article>
            ))}
          </div>

          <div className="composer">
            <textarea
              className="composer-input"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask the agent to inspect, change, explain, or verify code"
            />
            <button className="primary-button" disabled={isSending || !chatInput.trim()} onClick={handleSend}>
              {isSending ? "Running..." : "Send"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
