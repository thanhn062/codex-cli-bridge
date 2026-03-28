# Codex CLI Bridge Architecture

See also: [flowchart.md](./flowchart.md)

## Runtime Roles

- `Codex CLI`: execution worker (`codex exec`)
- `Codex CLI Bridge`: Ollama-compatible HTTP facade and execution guard
- local clients: Home Assistant, Ollama SDK clients, curl, and other local consumers
- external orchestration systems: optional callers; not owned by this project

## Core Modules

### HTTP API Layer

Own endpoint compatibility (`/api/tags`, `/api/ps`, `/api/generate`, `/api/chat`).

### Request Guard

Own single-request policy and busy rejections (`429`).

### Codex Execution Adapter

Own `codex exec` invocation, timeout control, and error mapping.

### Config Surface

Own environment variables and CLI flags.

## Non-Goals

- Telegram runtime features
- multi-agent orchestration
- bundled memory or MCP stack ownership
- cloud-hosted auth gateways
- prescribing any specific automation architecture

## Design Rule

Every new abstraction should answer a Codex CLI bridge compatibility or reliability need first.
