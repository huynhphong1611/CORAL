# CORAL

**CORAL** — Continuous Observation, Repair & Adaptive Learning. *Tests that grow back.*

AI-assisted UI testing for mobile apps (Android/iOS): an AI explores the app and writes test cases; test cases replay deterministically **without AI**; when a test fails, the AI tells "the UI changed" (proposes a reviewed fix) from "real bug" (files a bug); knowledge accumulates with every run. The AI brain is swappable between Claude, Gemini and GitHub Copilot.

- Specification: [`docs/SPEC.md`](docs/SPEC.md) · Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Working agreement: [`CLAUDE.md`](CLAUDE.md)
- Spec Kit feature docs: [`specs/`](specs/) · Constitution: [`.specify/memory/constitution.md`](.specify/memory/constitution.md)

## Quick start

Requires Node.js 24 (`corepack enable`) and, for infrastructure, Docker.

```bash
cp .env.example .env        # optional
pnpm install
pnpm dev                    # server :3000 · web :5173 · agent
docker compose up -d --wait # postgres · redis · minio
pnpm lint && pnpm typecheck && pnpm test
```

## Layout

| Path | Package | Role |
|---|---|---|
| `apps/server` | `@coral/server` | Control plane: API, auth, orchestrator, queue |
| `apps/web` | `@coral/web` | React SPA |
| `apps/agent` | `@coral/agent` | Daemon next to devices: runner, popup guard, live view (no AI) |
| `packages/shared` | `@coral/shared` | Types + Zod schemas |
| `packages/brain` | `@coral/brain` | Brain interface + provider adapters (server-only) |
| `packages/cli` | `@coral/cli` | The `coral` command |
