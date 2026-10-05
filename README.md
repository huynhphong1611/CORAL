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

## The web (Phase 2)

`pnpm dev` serves the SPA on `http://localhost:5173` (it proxies `/api` and `/api/ws/ui` to the server). Sign in with the seeded account, then, all from the browser:

- **Set up** — a project, its app (**Apps & builds** › New app), an APK build (upload with progress), and on **Devices** an agent token (**Add agent**: shown once, **Copy**) for `CORAL_AGENT_TOKEN`. No device at hand? `pnpm dev:fake-device` starts an agent whose device is a drawn look-alike of the Sauce Labs My Demo App.
- **Run** test cases and follow them live: every step with its screenshot, locator, time, and the device log when it fails.
- **Watch and control** a device (`/devices/<id>`): a live view at 2–5 fps; **Take control** to tap, swipe, type or go Back (one person at a time; runs wait).
- **Record** a test case (**Record a test case**): each click becomes a step with a chain of locators (id, text, desc, relative position, class index, the element's picture), a snapshot of the screen, and suggested expectations to accept; secrets are typed by name and stay `${secret:NAME}`. **Save** commits the YAML and its pictures to the project repo.
- **Edit** a test case: YAML checked as you type (problems on their line; Save locked), a picture beside each step (the recording's snapshot, else the latest run's screenshot), History, and a conflict warning instead of overwriting someone else's save.

An `image` locator (the element's picture) is tried in its place in the chain when the others miss: the step passes `degraded`, and nothing is tapped when no place looks alike. `coral run --project-root <dir>` reads those pictures from a project checkout. Browser checks: `pnpm test:e2e` (Playwright, Chromium). Step-by-step checks: [`specs/003-phase-2-web-recorder/quickstart.md`](specs/003-phase-2-web-recorder/quickstart.md).

## The AI (Phase 3)

The AI explores the app and writes test cases; the test cases still replay without AI. Configure it on the web (**AI › Brain config**, a `coral/brains@1` document: a provider and model per role, fallback, cost limits — see `examples/brains.example.yaml`) with keys in `.env` (`CORAL_ANTHROPIC_API_KEY`, `CORAL_GEMINI_API_KEY`; GitHub Copilot with `CORAL_COPILOT_ENABLED=true` and `CORAL_COPILOT_TOKEN`). No key at hand? `CORAL_BRAIN_FAKE=true` with `CORAL_BRAINS_DEFAULT=examples/brains.fake.yaml` runs a scripted brain at no cost.

- **Explore** (a project's **Explore**): the AI walks the app within a budget (steps, depth, minutes, USD) and never taps a `never_tap` button; follow it live — progress, the app map, the trace (what the AI saw and answered, its tool calls) and what it found. It then writes test cases, each validated by two runs in a row: `active`, else a `draft` saying why.
- **From a goal**: give the exploration a goal (`Open the cart until "My Cart"`) and get one test case of the way there.
- **Import** manual test cases (CSV, Excel, Gherkin): preview, choose the columns, and each case becomes an `active` test case or a `draft` with its reason (`needs_human`, `ambiguous`, `app_mismatch`).
- **Knowledge** tab: the project's `AGENTS.md`, skills (`SKILL.md` + `rules.yaml` with test data as `${secret:NAME}`) and `mcp.yaml` (MCP servers whose allowed tools the AI may call — see `examples/`). Secret values never reach the AI.
- **AI usage**: every call's cost, per day, role and provider, against the daily limit.

Checks with real AI on your own device: `node scripts/phase3-dod.mjs --help` ([`specs/004-phase-3-brain-explorer/quickstart.md`](specs/004-phase-3-brain-explorer/quickstart.md) §8).

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
