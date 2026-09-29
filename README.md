# CORAL

**CORAL** — Continuous Observation, Repair & Adaptive Learning. *Tests that grow back.*

AI-assisted UI testing for mobile apps (Android/iOS): an AI explores the app and writes test cases; test cases replay deterministically **without AI**; when a test fails, the AI tells "the UI changed" (proposes a reviewed fix) from "real bug" (files a bug); knowledge accumulates with every run. The AI brain is swappable between Claude, Gemini and GitHub Copilot.

- Specification: [`docs/SPEC.md`](docs/SPEC.md) · Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Working agreement: [`CLAUDE.md`](CLAUDE.md)
- Spec Kit feature docs: [`specs/`](specs/) · Constitution: [`.specify/memory/constitution.md`](.specify/memory/constitution.md)

## Quick start

Requires Node.js 24 (`corepack enable`) and, for infrastructure, Docker.

```bash
cp .env.example .env        # then set CORAL_JWT_SECRET, CORAL_SEED_EMAIL, CORAL_SEED_PASSWORD
pnpm install
docker compose up -d --wait # postgres · redis · minio
pnpm --filter @coral/server db:migrate && pnpm --filter @coral/server db:seed
pnpm dev                    # server :3000 · web :5173 · agent
pnpm lint && pnpm typecheck && pnpm test && pnpm test:int
```

## Running test cases (Phase 1: Android)

Test cases are YAML files (`coral/testcase@1`, see `docs/SPEC.md` §7 and `examples/`). They replay deterministically, without AI.

```bash
pnpm coral validate fixtures/testcases/mydemo-login.yaml     # schema + semantic checks
pnpm coral devices                                           # Android devices seen by adb
pnpm coral run fixtures/testcases/mydemo-login.yaml \
  --app com.saucelabs.mydemoapp.android --apk ./mydemo.apk   # local run, results in ./coral-results/
```

Through the server: create an agent token with `POST /agents`, put it in `.env` as `CORAL_AGENT_TOKEN`, start `pnpm dev`, then save test cases and start runs over the REST API. `scripts/phase1-e2e.mjs` does all of it and checks the Phase 1 definition of done:

```bash
node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-login.yaml --runs 5
```

Secrets used by test cases (`${secret:NAME}`) come from `CORAL_SECRET_<NAME>` in `.env` for now (development only) and are masked in every log and artifact. Step-by-step checks: [`specs/002-phase-1-android-runner/quickstart.md`](specs/002-phase-1-android-runner/quickstart.md).

## Layout

| Path | Package | Role |
|---|---|---|
| `apps/server` | `@coral/server` | Control plane: API, auth, orchestrator, queue |
| `apps/web` | `@coral/web` | React SPA |
| `apps/agent` | `@coral/agent` | Daemon next to devices: runner, popup guard, live view (no AI) |
| `packages/shared` | `@coral/shared` | Types + Zod schemas |
| `packages/brain` | `@coral/brain` | Brain interface + provider adapters (server-only) |
| `packages/cli` | `@coral/cli` | The `coral` command |
| `packages/runner` | `@coral/runner` | Deterministic runner shared by the agent and `coral run` (no AI) |
