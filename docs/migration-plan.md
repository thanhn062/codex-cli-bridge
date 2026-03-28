# Migration Plan

Codex CLI Bridge is published as a standalone project with a narrow boundary.

The migration rule is:

> migrate behavior, not inheritance

## Stage 1

Publish a clean repo with:

- stable package metadata
- clear API docs
- reproducible local/Docker/systemd startup
- minimal runtime focused on Codex CLI + Ollama-compatible HTTP

## Stage 2

Lock the runtime contract:

- localhost bind by default
- no auth by default (trusted local use)
- single-request execution guard
- `stream=true` rejection path

## Stage 3

Harden execution behavior:

- strict request size limits
- timeout control for `codex exec`
- explicit error mapping for unavailable models and execution failures

## Stage 4

Maintain compatibility surface without taking stack ownership:

- preserve Ollama-style endpoints needed by local clients
- avoid coupling to any specific orchestration/memory platform

## Stage 5

Evolve as a bridge product:

- add optional auth/proxy guidance for non-local deployments
- keep protocol behavior stable and versioned
- avoid expanding into general agent runtime concerns
