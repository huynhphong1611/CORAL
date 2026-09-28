# Tasks: Phase 0 — Khung dự án

**Input**: Design documents from `specs/001-phase-0-foundation/`
**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Format**: `[ID] [P?] [Story] Description` — `[P]` chạy song song được (khác file, không phụ thuộc nhau).

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Đưa `CLAUDE.md`, `docs/SPEC.md`, `docs/ROADMAP.md` vào repo; tạo `examples/` (testcase, popups, brains) và `fixtures/README.md`
- [x] T002 Rà soát SPEC, chốt tech stack; ghi `research.md`, SPEC §19, §21 (D07–D27)
- [x] T003 Cài Spec Kit (`.specify/`, `.claude/skills/speckit-*/`), viết `.specify/memory/constitution.md` từ P1–P6
- [x] T004 Root workspace: `package.json` (scripts, `packageManager`, `engines`), `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.env.example`
- [x] T005 [P] TypeScript: `tsconfig.base.json` (strict + `noUncheckedIndexedAccess`), `tsconfig.json` gốc cho scripts và file config
- [x] T006 [P] Prettier: `.prettierrc.json`, `.prettierignore`
- [x] T007 [P] ESLint flat config type-aware: `eslint.config.js`
- [x] T008 [P] Vitest projects: `vitest.config.ts`, `vitest.shared.ts` (loại `*.device.test.ts` trừ khi `CORAL_DEVICE_TESTS=1`)

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T009 `packages/shared`: `CORAL_VERSION`, `LOG_LEVELS`, `healthResponseSchema` + test (`src/health.test.ts`)

## Phase 3: User Story 1 — Một lệnh khởi động (P1) 🎯 MVP

**Independent Test**: `pnpm dev` → `curl :3000/health`, mở `:5173`, log agent `server reachable`.

- [x] T010 [P] [US1] `apps/server`: config Zod (`src/config.ts`), Fastify `GET /health` (`src/server.ts`), `src/main.ts`, test `config.test.ts`, `server.test.ts`
- [x] T011 [P] [US1] `apps/agent`: config Zod, `fetchServerHealth` (`src/server-client.ts`), vòng probe + tắt êm (`src/main.ts`), test
- [x] T012 [P] [US1] `apps/web`: Vite + React + TanStack Query, proxy `/api`, `fetchHealth` + test
- [x] T013 [P] [US1] `packages/cli`: commander `coral --version/--help` + test; `pnpm coral` ở gốc
- [x] T014 [P] [US1] `packages/brain`: khung + `BRAIN_PROVIDERS` + test
- [x] T015 [US1] `tsdown.config.ts` cho server/agent/cli; `pnpm build` tạo `dist/main.js` chạy được bằng `node`

## Phase 4: User Story 2 — Cổng chất lượng (P1)

- [x] T016 [US2] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` xanh trên toàn repo

## Phase 5: User Story 3 — Luật P1 (P1)

- [x] T017 [US3] `scripts/boundaries.mjs` (manifest + lockfile bắc cầu + options ESLint) và test `scripts/boundaries.test.ts`
- [x] T018 [US3] `scripts/check-boundaries.mjs` + `pnpm check:boundaries`; ESLint `no-restricted-imports` theo nhóm gói

## Phase 6: User Story 4 — Hạ tầng dev (P2)

- [x] T019 [US4] `compose.yaml`: postgres 17, redis 7 (noeviction), minio — healthcheck + volume

## Phase 7: User Story 5 — CI (P2)

- [x] T020 [US5] `.github/workflows/ci.yml`: job `checks` (format, lint, boundaries, typecheck, test, build) và `infra` (docker compose up --wait)

## Phase 8: User Story 6 — Spec Kit & tài liệu (P3)

- [x] T021 [US6] Điền "Lệnh thường dùng" và quy trình Spec Kit trong `CLAUDE.md`; cập nhật `README.md`

## Phase 9: Polish & DoD

- [x] T022 Chạy `quickstart.md`: `pnpm install && pnpm dev` (3 service), toàn bộ cổng chất lượng
- [x] T023 Push, xác nhận CI xanh (cả `infra`)
- [x] T024 Đánh dấu `[x]` trong ROADMAP Phase 0, cập nhật "Phase hiện tại" → Phase 1

## Dependencies & Execution Order

- Setup (T001–T008) → Foundational (T009) → US1 (T010–T015, song song) → US2 (T016) → US3/US4/US5 (song song) → US6 → Polish.
- T016 phụ thuộc mọi gói đã có code; T023 phụ thuộc T016–T020.
