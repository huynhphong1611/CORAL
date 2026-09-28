<!--
Sync Impact Report
- Version change: (template) → 1.0.0
- Principles added: I. AI writes, scripts run (P1) · II. Locate, don't memorise coordinates (P2)
  · III. No blind healing (P3) · IV. Provider-neutral knowledge (P4) · V. Tenant isolation from day one (P5)
  · VI. Safe operation (P6)
- Sections added: Engineering Constraints, Development Workflow, Governance
- Templates: .specify/templates/plan-template.md ✅ (Constitution Check reads this file)
  · spec-template.md ✅ · tasks-template.md ✅ — no edits required
- Follow-up TODOs: none
-->

# coral Constitution

Source of truth for architecture and behaviour is `docs/SPEC.md`; this constitution restates its
invariant principles (SPEC §2) as gates for every Spec Kit plan. Where the two ever disagree,
`docs/SPEC.md` wins and this file MUST be amended.

## Core Principles

### I. AI writes, scripts run (P1)
The runner (`packages/runner`, `apps/agent`) MUST NOT use AI. Only `packages/brain` MAY depend on an
LLM SDK; only `apps/server` MAY depend on `@coral/brain`; apps MUST NOT import other apps (SPEC D08).
LLMs are used only by the Explorer, Test writer, Healer and Popup resolver on the server.
The rule is enforced by ESLint (`no-restricted-imports`) and `pnpm check:boundaries`
(package manifests and the transitive lockfile graph); a plan that needs an exception is rejected.

### II. Locate, don't memorise coordinates (P2)
Every step stores a fallback chain of locators. The runner MUST read the element's real `bounds` at
run time and tap its centre; `point_pct` is the last resort only. The AI never invents locators — they
are extracted from the element tree.

### III. No blind healing (P3)
The Healer MUST classify failures as `heal` / `bug` / `flaky` / `env`. Every change to a test case,
popup rule or locator chain is a proposal (diff) that a human approves. A proposal MUST NOT delete or
loosen an `expect`, change the `intent`, drop steps wholesale, or add a tap on a `never_tap` element.

### IV. Provider-neutral knowledge (P4)
Memory and skills are plain files (YAML / JSON / Markdown, `AGENTS.md`, `SKILL.md`) in the project's
git repo, never tied to Claude, Gemini or Copilot. Model names are configuration, never code.

### V. Tenant isolation from day one (P5)
Every business table has `tenant_id` (only `tenants`, `users`, `refresh_tokens` are global — D10).
Database access goes through tenant-scoped repositories (Postgres RLS from Phase 5); object storage
uses a per-tenant prefix; AI context comes only from the project being run. Secrets live in `.env` or
the encrypted `secrets` table and appear in YAML only as `${secret:NAME}`.

### VI. Safe operation (P6)
Machine-decided actions (popup guard, popup resolver, Explorer, heal patches, test-writer drafts)
MUST respect `never_tap` (SPEC §9.4). The agent MUST NOT run destructive device commands (factory
reset, wiping data outside the app under test).

## Engineering Constraints

- TypeScript strict, ESM, Node.js 24; stack as fixed in SPEC §19 (D07).
- Zod validates everything entering from outside: YAML, WebSocket messages, API requests, LLM output,
  environment variables.
- Wire formats (YAML, JSON API, WS, DB columns) use `snake_case`; TypeScript code uses `camelCase` (D12).
- Tests use Vitest; tests needing a real device are named `*.device.test.ts` and never run in CI (D21).
- Database changes go through Drizzle migrations; an applied migration is never edited.
- Code, identifiers, comments and commit messages are in English; conversation with the project owner
  is in Vietnamese.

## Development Workflow

- Work only on the current phase of `docs/ROADMAP.md`; each phase is one feature in
  `specs/NNN-phase-N-<slug>/` (D22). Branches are named by the environment; point Spec Kit at the feature with
  `SPECIFY_FEATURE_DIRECTORY=specs/NNN-phase-N-<slug>` (or `.specify/feature.json`).
- Flow: `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-analyze` → `/speckit-implement`. Present the plan and wait for the owner's approval before
  coding a group of tasks.
- Small commits, each task with tests; tick `[x]` in `tasks.md` and the ROADMAP when done.
- A phase ends only when every Definition of Done item is verified and reported.

## Governance

- Deviating from `docs/SPEC.md` requires the owner's approval first; the SPEC section and the §21
  Decision log are then updated in the same change, and this constitution if a principle is affected.
- Versioning: MAJOR for removing or redefining a principle, MINOR for a new principle or section,
  PATCH for wording.
- Every plan's Constitution Check MUST evaluate principles I–VI; violations need an entry in the
  plan's Complexity Tracking with the rejected simpler alternative.

**Version**: 1.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-09-28
