# Code Agent

An OpenClaw-inspired coding agent with a web UI, Monaco editor, indexed code search, and a tool-calling backend for a local workspace.

## What is included

- React web UI with Monaco editor
- Express API server
- coding-agent loop with tool calls
- local session persistence
- workspace-safe file tools
- local code index with:
  - heuristic semantic chunking
  - BM25-style keyword retrieval
  - optional embedding-based vector retrieval
  - hybrid RRF fusion
  - filesystem watch and auto-rebuild
- CLI entrypoints for one-shot tasks, REPL, index rebuild, and search

## Model setup

This project is set up for MiniMax M2.5 by default.

```bash
cp .env.example .env
```

Minimum chat config:

```bash
MINIMAX_API_KEY=your_minimax_api_key
CHAT_BASE_URL=https://api.minimaxi.com/v1
CHAT_MODEL=MiniMax-M2.5
```

Optional embedding config for vector retrieval:

```bash
EMBEDDING_API_KEY=your_embedding_key
EMBEDDING_BASE_URL=https://your-openai-compatible-embedding-endpoint/v1
EMBEDDING_MODEL=your-embedding-model
```

If embedding config is missing, the index still works with keyword retrieval only.

## Run the app

Install dependencies:

```bash
npm install
```

Start the backend:

```bash
npm run dev
```

Start the frontend:

```bash
npm run dev:web
```

Production build:

```bash
npm run build
npm start
```

The server defaults to `http://127.0.0.1:3000`.

## One-command Docker startup

If you want a single command instead of running backend and frontend separately:

```bash
docker compose up --build
```

Then open:

- [http://127.0.0.1:3000](http://127.0.0.1:3000)

How it works:

- the container serves both the API and built web UI
- the current project directory is mounted into `/workspace`
- all file edits from the agent are written back to your host files
- the app inside the container reads `CODE_AGENT_WORKSPACE=/workspace`

## CLI

The CLI still works for direct local agent usage:

```bash
npm run cli -- run "explain this repo"
npm run cli -- repl
npm run cli -- index
npm run cli -- search "index manager"
```

Top-level commands:

- `run`
- `repl`
- `index`
- `search`
- `tools`

Useful options:

```bash
--workspace <path>   Workspace root, defaults to current directory
--session <id>       Session id, defaults to main
--model <name>       Override model from env
--max-steps <n>      Max model/tool rounds, defaults to 6
--reset              Reset the session before running
```

## Web UI

The web app includes:

- file browser
- Monaco editor with save-back-to-workspace
- indexed code search panel
- agent chat panel with tool activity stream
- index status and manual rebuild

## API surface

Main endpoints:

- `GET /api/config`
- `GET /api/index/status`
- `POST /api/index/rebuild`
- `GET /api/search`
- `GET /api/files/list`
- `GET /api/files/content`
- `POST /api/files/content`
- `GET /api/sessions/:sessionId`
- `POST /api/agent/stream`

## Project structure

- `src/server.ts`: API server entry
- `src/api/app.ts`: HTTP routes and SSE streaming
- `src/agent/loop.ts`: tool-calling agent loop
- `src/rag/index-manager.ts`: indexing, watch, and search
- `src/rag/chunker.ts`: semantic chunking heuristics
- `src/tools/definitions.ts`: workspace-safe coding tools
- `web/src/App.tsx`: React application shell

## Prompt gap report

The implementation status against `coding-agent-prompt.md` is documented in:

- `PROMPT_GAP_REPORT.md`

## Validate

```bash
npm run build
npm test
```
