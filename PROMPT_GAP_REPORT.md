# Prompt Gap Report

Comparison target:

- `/Users/pineapple/.openclaw/workspace-dev/coding-agent-prompt.md`

## Implemented

### Project skeleton

- TypeScript project initialized
- Node backend implemented
- React frontend implemented
- Monaco editor integrated
- CLI retained alongside the web app

### Agent loop

- message intake
- session loading and persistence
- prompt building
- tool planning through model tool-calling
- tool execution
- multi-step loop with max-step cap
- final response generation
- SSE event stream for UI status and tool activity

### Coding tools

- `read_file`
- `write_file`
- `edit_file`
- `search_code`
- `list_directory`
- `glob`
- `execute_command`

### Code retrieval

- workspace scan
- file watch with automatic index rebuild
- semantic chunking heuristics by code declaration
- BM25-style keyword scoring
- optional embedding-based vector retrieval
- hybrid RRF fusion
- retrieval injected into agent context

### Frontend

- chat panel
- Monaco editor
- streaming response handling
- file browser
- index rebuild/status UI

### Basic platform controls

- local workspace boundary for tools and file APIs
- in-memory rate limiting middleware
- optional bearer-token API auth

## Partially implemented

### Streaming

- Implemented:
  - SSE streaming from backend to frontend
  - status/tool events stream immediately
  - assistant text streams to the UI after the final tool loop result is available
- Missing vs prompt ideal:
  - true token-level model streaming during each generation step

### Context compaction

- Implemented:
  - bounded session history retention
- Missing vs prompt ideal:
  - multi-layer summarization strategy for old turns

### Vector retrieval

- Implemented:
  - pluggable OpenAI-compatible embeddings client
  - local vector storage in the persisted snapshot
- Validated locally:
  - embeddings can be generated through an OpenAI-compatible endpoint
  - hybrid retrieval runs with `vectorEnabled: true` when embedding env vars are present
- Repo expectation:
  - embedding credentials still come from local environment variables and are not committed

## Not implemented

### Storage layer from the prompt

- Redis session cache
- MySQL persistent store
- tenant-aware persistence model
- qdrant vector database

Reason:

- this repo is currently a local single-workspace application
- the working version uses local JSON persistence and local vector storage instead

### Auth design from the prompt

- JWT auth
- Redis-backed sliding-window rate limiting

Reason:

- replaced with a simpler local bearer-token guard and in-memory limiter suitable for single-user local use

### Tree-sitter chunking

- Not implemented

Current replacement:

- heuristic semantic chunker based on language-specific declaration patterns

### Exact prompt architecture extras

- Redis TTL session cache
- MySQL tenant partitioning
- qdrant collection management
- full multi-tenant API gateway model

## Current practical status

This repo now has:

- a working backend
- a working web UI
- Monaco integration
- a working local code index
- a working hybrid-search pipeline shape
- a validated embedding-backed vector search path when local env vars are configured
- MiniMax-ready chat model configuration

The remaining gaps are mainly infrastructure differences from the original prompt, not missing app structure.
