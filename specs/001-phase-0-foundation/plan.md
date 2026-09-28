# Implementation Plan: Phase 0 — Khung dự án

**Branch**: `claude/phase-0-planning-tech-stack-6m4j5c` (feature `001-phase-0-foundation`) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-phase-0-foundation/spec.md`

## Summary

Dựng monorepo pnpm + Turborepo với sáu gói khung (server, web, agent, shared, brain, cli), cổng chất lượng (TS strict, ESLint type-aware, Prettier, Vitest), luật ranh giới P1 được kiểm tra tự động, hạ tầng dev bằng Docker Compose, CI GitHub Actions và Spec Kit. Các service chỉ có một contract chung: `GET /health` (Zod schema trong `packages/shared`), dùng để chứng minh server ↔ web ↔ agent nối được với nhau.

## Technical Context

**Language/Version**: TypeScript 6.0 (strict), Node.js 24 LTS, ESM
**Primary Dependencies**: Fastify 5, Zod 4, pino 10, React 19, Vite 8, TanStack Query 5, commander 15; dev: pnpm 10, Turborepo 2, tsx, tsdown 0.23, Vitest 5, ESLint 10 + typescript-eslint 8, Prettier 3
**Storage**: Postgres 17, Redis 7, MinIO (`pgsty/minio`, D26) — chỉ dựng bằng Docker Compose ở phase này, chưa kết nối từ code
**Testing**: Vitest (projects: `apps/*`, `packages/*`, `scripts`); `*.device.test.ts` bị loại mặc định
**Target Platform**: Linux/macOS/Windows (WSL2) cho dev; CI `ubuntu-latest`
**Project Type**: Web service + SPA + daemon + CLI trong một monorepo
**Performance Goals**: `pnpm dev` < 30 s; CI job `checks` < 15 phút
**Constraints**: P1 (không LLM ngoài `packages/brain`); không cần Docker để chạy `pnpm dev`
**Scale/Scope**: 6 gói, ~40 file mã nguồn

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Kiểm tra | Kết quả |
|---|---|---|
| P1 AI viết, script chạy | `apps/agent`, `packages/cli`, `packages/shared`, `apps/web` không phụ thuộc `@coral/brain` / LLM SDK; có luật máy kiểm tra (ESLint + `check:boundaries`) | PASS |
| P2 Lưu cách tìm element | Không có runner ở Phase 0; ví dụ `examples/testcase.example.yaml` dùng chuỗi locator, `point_pct` cuối | PASS (N/A code) |
| P3 Không heal mù | Không có Healer ở Phase 0 | N/A |
| P4 Tri thức trung lập provider | Ví dụ đều là YAML thuần; không có SDK provider nào được cài | PASS |
| P5 Cô lập tenant | Không có bảng DB ở Phase 0; quy tắc D10 đã ghi cho Phase 1 | N/A |
| P6 An toàn thao tác | Phạm vi `never_tap` đã làm rõ (§9.4) | PASS (N/A code) |
| Quy ước | TS strict, Zod cho env + HTTP response, không hard-code model, secret chỉ trong `.env` | PASS |

## Project Structure

### Documentation (this feature)

```text
specs/001-phase-0-foundation/
├── spec.md              # /speckit-specify
├── research.md          # tech stack + rà soát SPEC
├── plan.md              # file này
├── quickstart.md        # chạy và kiểm tra DoD
├── tasks.md             # /speckit-tasks
└── checklists/
    └── requirements.md  # chất lượng spec
```
Không có `data-model.md` / `contracts/`: Phase 0 không có entity; contract duy nhất (`HealthResponse`) nằm ở `packages/shared/src/health.ts`.

### Source Code (repository root)

```text
apps/
├── server/   src/{main,server,config}.ts        Fastify, GET /health
├── web/      src/{main.tsx,App.tsx,api.ts}       Vite + React + TanStack Query, proxy /api
└── agent/    src/{main,config,server-client}.ts  probe /health mỗi CORAL_AGENT_POLL_MS
packages/
├── shared/   src/{index,health,log,version}.ts  Zod schema dùng chung (Node + browser)
├── brain/    src/index.ts                        khung, danh sách provider
└── cli/      src/{main,program}.ts               `coral --version | --help`
scripts/
├── boundaries.mjs         luật D08 (thuần, có test)
└── check-boundaries.mjs   CLI: manifest + pnpm-lock.yaml
fixtures/  examples/  docs/  specs/  .specify/  .claude/commands/
compose.yaml  turbo.json  pnpm-workspace.yaml  tsconfig.base.json  tsconfig.json
eslint.config.js  vitest.config.ts  vitest.shared.ts  .github/workflows/ci.yml
```

**Structure Decision**: Monorepo theo `CLAUDE.md`; gói `packages/*` xuất source TS (không build), `apps/*` + `packages/cli` bundle bằng tsdown/Vite. `packages/runner` được tạo ở Phase 1 (D09).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Kiểm tra lockfile tự viết (`scripts/boundaries.mjs`) thay vì chỉ ESLint | P1 phải bắt cả phụ thuộc bắc cầu qua thư viện bên thứ ba | ESLint chỉ thấy import trong source; dependency-cruiser không đọc lockfile |
| Job CI `infra` dựng Docker Compose | DoD yêu cầu `docker compose up -d` chạy đủ 3 dịch vụ; cần kiểm chứng tự động | Kiểm tra tay dễ bị bỏ quên khi sửa `compose.yaml` |
