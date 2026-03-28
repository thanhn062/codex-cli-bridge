# Codex CLI Bridge Flowchart

This diagram reflects the public shape of the standalone bridge runtime.

```mermaid
flowchart TD
    Client["Local Client (HA/Ollama SDK/curl)"]
    HTTP["Codex CLI Bridge HTTP"]
    Guard["Single-Request Guard"]
    Exec["codex exec adapter"]
    Codex["Codex CLI"]
    Resp["Ollama-Compatible JSON"]

    Client --> HTTP
    HTTP --> Guard
    Guard --> Exec
    Exec --> Codex
    Codex --> Resp
    Resp --> Client
```

## Reading The Diagram

- Bridge owns HTTP compatibility plus execution limits.
- Codex CLI remains the worker process.
- Calling clients are external to the bridge and remain user-chosen.

## Boundary

Codex CLI Bridge should not prescribe orchestration, memory, or automation stack choices.
