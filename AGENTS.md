# AGENTS

## Project Intent

This repository is the standalone home for **Codex CLI Bridge**.

Keep the architecture narrow:

- Codex is the primary worker
- Ollama-compatible HTTP is the primary protocol surface
- this project owns only the Codex CLI bridge runtime surface

Stay neutral about orchestration, memory, and MCP stack choices. This repo should expose a clean bridge boundary, not prescribe the rest of the user's system.

Do not reintroduce multi-agent or channel abstractions that are outside the bridge scope.

## Implementation Rules

- Prefer small, composable modules over broad adapter frameworks.
- Keep public docs aligned with the Codex CLI Bridge product boundary.
- Do not bake Memora, `n8n`, or any other specific orchestration stack into the product identity.
- Treat this repo as a standalone public project.
