# Implementation Plan: Phase 1 — Runner tất định trên Android + server tối thiểu

**Branch**: `claude/phase-0-planning-tech-stack-6m4j5c` (feature `002-phase-1-android-runner`) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-phase-1-android-runner/spec.md`

## Summary

Chạy một test case YAML viết tay trên Android emulator, tất định, không AI, theo hai đường:
1. **Cục bộ** — `coral validate` / `coral run` gọi thẳng `packages/runner` (mới, D09).
2. **Qua server** — người vận hành lưu test case vào kho git của project (D15, D31), tạo run; server giữ lease thiết bị (D16) và giao job cho `coral-agent` qua WebSocket (§15, D18); agent chạy runner, gửi kết quả từng step, tải artifact lên MinIO bằng presigned URL.

Hướng kỹ thuật chính:
- Runner tách **lõi trung lập** (resolver, chờ ổn định, `expect`, popup guard, vòng lặp §8.2) khỏi **driver** (D28). Lõi chỉ biết `UiDriver` + `TargetLifecycle`.
- Driver Android gọi thẳng server UiAutomator2 `u2.jar` qua JSON-RPC + `adb forward` (D27); screenshot bằng `adb exec-out screencap`; cài đặt/quyền/log bằng `adb`.
- Schema test case, luật popup, message WS và DTO API là Zod trong `packages/shared` — một nguồn cho CLI, agent, server và web (Phase 2).
- Server: Fastify + Drizzle/Postgres + BullMQ/Redis + S3 (MinIO) + simple-git; mọi bảng nghiệp vụ có `tenant_id`, truy cập qua repository có tenant scope.

Chi tiết quyết định: [research.md](./research.md). Dữ liệu: [data-model.md](./data-model.md). Giao diện: [contracts/](./contracts/). Kiểm chứng: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict), Node.js 24 LTS, ESM

**Primary Dependencies**:
- `packages/shared`: zod 4, yaml
- `packages/runner` (mới): fast-xml-parser (cây UiAutomator), fflate (giải nén wheel lấy `u2.jar`); `adb` + `u2.jar` 0.4.0 (từ `uiautomator2` 3.7.0) là phụ thuộc ngoài
- `apps/server`: fastify 5, @fastify/websocket, @fastify/multipart, @fastify/cookie, drizzle-orm + pg (+ drizzle-kit), bullmq, @aws-sdk/client-s3 + s3-request-presigner, simple-git, @node-rs/argon2, jose, uuidv7, pino
- `apps/agent`: ws, pino, `@coral/runner`
- `packages/cli`: commander, `@coral/runner`

**Storage**: PostgreSQL 17 (metadata), Redis 7 (BullMQ), MinIO/S3 (build APK, artifact), git repo mỗi project trên volume `CORAL_DATA_DIR` (test case, `popups.yaml`)

**Testing**: Vitest 5 — unit `*.test.ts` (CI, không cần hạ tầng); tích hợp `*.int.test.ts` cần Postgres/Redis/MinIO (CI job riêng, dựng bằng `docker compose`); thiết bị `*.device.test.ts` (D21, chạy tay trên máy có emulator). Fixture cây element giả trong `fixtures/android/` cho resolver.

**Target Platform**: server + agent trên Linux/macOS/Windows-WSL2; thiết bị Android 9+ (API 28+), tham chiếu Android 14 emulator x86_64

**Project Type**: monorepo — web service + daemon + CLI + thư viện runner

**Performance Goals**: test đăng nhập ~10 step < 60 s trên emulator tham chiếu (SC-005); artifact step sẵn sàng < 10 s sau khi run kết thúc (SC-002); phát hiện agent offline < 60 s (SC-009)

**Constraints**: không AI trong runner/agent (P1); tap vào tâm bounds đọc lúc chạy (P2); dữ liệu gắn tenant (P5); không thao tác phá hủy ngoài app đang test (P6); secret không lộ trong log/artifact (D19); server một instance (R10)

**Scale/Scope**: 1 tenant seed, vài agent, ≤10 thiết bị; run ≤ 50 test case; ~8 gói/app bị ảnh hưởng

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Thiết kế Phase 1 | Trước research | Sau design |
|---|---|---|---|
| I. AI viết, script chạy (P1) | `packages/runner`, `apps/agent`, `packages/cli` không phụ thuộc `@coral/brain`/LLM SDK — `pnpm check:boundaries` tự phủ gói mới. Thêm luật ESLint: `runner/src/core/**` không import `drivers/**`, `node:child_process` (D28). | PASS | PASS |
| II. Locate, don't memorise (P2) | Resolver thử chuỗi locator theo thứ tự; tap vào tâm bounds của cây vừa dump; kiểm tra element trên cùng; `point_pct` chỉ khi mọi locator khác trượt. | PASS | PASS |
| III. No blind healing (P3) | Phase 1 chỉ đánh dấu `degraded`; không sửa test case tự động. | PASS | PASS |
| IV. Provider-neutral knowledge (P4) | Test case + `popups.yaml` là YAML thuần trong git project. | PASS | PASS |
| V. Tenant isolation (P5) | Mọi bảng nghiệp vụ có `tenant_id`; route chỉ truy cập DB qua `repos/**` (ESLint chặn import `db/**` từ `routes/**`); repository nhận `TenantContext` và đặt `app.tenant_id` trong transaction (sẵn cho RLS ở Phase 5); key S3 bắt đầu bằng `<tenant_id>/`; repo git theo `repos/<tenant_id>/<project_id>`; agent chỉ nhận job cùng tenant. | PASS | PASS |
| VI. Safe operation (P6) | Guard không bấm `never_tap`, không đóng dialog crash/ANR; agent chỉ `pm clear`/`pm grant`/`install` cho package đang test; thay đổi cài đặt animation được ghi lại và khôi phục trên máy thật khi dọn dẹp. | PASS | PASS |
| Ràng buộc kỹ thuật | Zod cho YAML/WS/API/env; `snake_case` trên dây (D12); Drizzle migration; device test `*.device.test.ts`. | PASS | PASS |

Không có vi phạm cần biện minh; các lựa chọn làm tăng độ phức tạp ghi ở Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-phase-1-android-runner/
├── plan.md              # file này
├── research.md          # quyết định kỹ thuật (Phase 0)
├── data-model.md        # bảng DB, trạng thái, bố cục git/S3 (Phase 1)
├── quickstart.md        # kịch bản kiểm chứng DoD
├── contracts/
│   ├── testcase-format.md   # coral/testcase@1 + coral/popups@1 như Zod sẽ kiểm tra
│   ├── rest-api.md          # REST cho người vận hành
│   ├── ws-protocol.md       # agent ↔ server
│   ├── cli.md               # coral validate / coral run
│   └── android-u2.md        # phần JSON-RPC của u2.jar mà driver dùng
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (chưa tạo)
```

### Source Code (repository root)

```text
packages/shared/src/
├── testcase/            # schema.ts (Zod coral/testcase@1), validate.ts (kiểm tra ngữ nghĩa), parse.ts (YAML → object + vị trí dòng)
├── popups/              # schema.ts (coral/popups@1), match.ts (so khớp luật, never_tap — thuần)
├── element.ts           # ElementNode, Bounds (+ Zod cho artifact tree.json)
├── permissions.ts       # từ vựng §7.5 → permission Android
├── failure-codes.ts     # §8.5
├── redact.ts            # che giá trị secret
├── protocol/            # envelope.ts + messages.ts (§15, D18)
└── api/                 # DTO REST (snake_case)

packages/runner/src/     # MỚI (D09)
├── core/                # KHÔNG import drivers/ hay node:child_process (D28)
│   ├── driver.ts        # UiDriver, TargetLifecycle, DeviceDriver
│   ├── locator/         # resolve.ts, class-match.ts, rel.ts
│   ├── stability.ts     # waitForStable (§8.3)
│   ├── expect.ts        # checkExpect (§7.3)
│   ├── actions.ts       # §7.1
│   ├── hit-test.ts      # element trên cùng tại điểm tap (§8.4)
│   ├── popup-guard.ts   # lớp 2 (§9.2, §9.4, D25)
│   ├── interpolate.ts   # ${secret:}, ${var:}
│   ├── artifacts.ts     # ArtifactSink interface
│   └── run-testcase.ts  # vòng lặp §8.2 → sự kiện step/item
├── drivers/android/
│   ├── adb.ts           # bọc adb (execFile), liệt kê thiết bị
│   ├── u2-assets.ts     # tải wheel uiautomator2 3.7.0, lấy + kiểm sha256 u2.jar, cache
│   ├── u2-server.ts     # push jar, app_process, adb forward, chờ sẵn sàng
│   ├── u2-client.ts     # JSON-RPC 2.0 client
│   ├── hierarchy.ts     # XML → ElementNode[]
│   ├── lifecycle.ts     # install, pm clear, pm grant, animation, launch, deeplink, logcat, crash/ANR
│   └── android-driver.ts
├── sinks/local-dir.ts   # ArtifactSink ghi ra thư mục (coral run)
└── testing/fake-driver.ts # FakeDriver kịch bản màn hình cho unit/tích hợp

packages/cli/src/commands/   # validate.ts, run.ts

apps/agent/src/
├── connection.ts        # ws + reconnect backoff + heartbeat
├── devices.ts           # theo dõi `adb devices` → device.update
├── jobs.ts              # mỗi thiết bị một job; hủy bằng AbortController
└── upload-sink.ts       # ArtifactSink: xin presigned URL, PUT lên S3

apps/server/src/
├── config.ts            # thêm DATABASE_URL, REDIS_URL, S3_*, CORAL_DATA_DIR, CORAL_JWT_SECRET, seed
├── db/                  # schema.ts (Drizzle), migrations/, client.ts, tenant.ts (withTenant)
├── http/errors.ts       # định dạng lỗi + plugin validate Zod
├── repos/               # repository có tenant scope — routes/** không import db/** (ESLint)
├── auth/                # login/refresh/logout, argon2id, JWT, guard
├── git/project-repo-store.ts
├── storage/s3.ts        # bucket, presign, lifecycle 30 ngày
├── agents/              # gateway WS, registry kết nối, heartbeat/offline
├── runs/                # tạo run, dispatcher (BullMQ), lease, lease-sweeper, timeout, xử lý step/item/job
├── routes/              # auth, projects, apps, builds, agents, devices, testcases, popups, runs
└── seed.ts              # tenant + user seed

fixtures/android/        # XML dump + tree.json mẫu (màn đăng nhập, dialog quyền, crash dialog…)
fixtures/testcases/      # file hợp lệ / lỗi cho SC-006
scripts/phase1-e2e.mjs   # tạo project→build→test case→5 run, kiểm tra DoD
```

**Structure Decision**: giữ monorepo hiện có; thêm `packages/runner` (D09). Lõi runner và driver tách thư mục, được ESLint kiểm tra (D28). Mọi schema dùng chung nằm ở `packages/shared` để Phase 2 (web editor) dùng lại.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Gói mới `packages/runner` | `coral run` (CLI) và agent cùng cần runner; app không import app (D08, D09) | Để runner trong `apps/agent` buộc CLI import một app |
| BullMQ **và** lease trong Postgres | BullMQ lo hàng đợi, thử lại, timeout có hẹn giờ; Postgres (partial unique index) là nơi đảm bảo "một thiết bị một lease" tuyệt đối (SC-007) | Chỉ BullMQ: không có ràng buộc toàn vẹn khi server lỗi giữa chừng; chỉ Postgres: phải tự viết hàng đợi có hẹn giờ |
| Kho git project ngay Phase 1 | Chủ dự án chốt test case sinh ra và lưu trong coral (Q1, D31); `run_items.commit` cần phiên bản | Gửi YAML kèm run: phải làm lại API tạo run ở Phase 2 |
| Tải `u2.jar` lúc chạy thay vì vendor vào repo | Không chứa binary bên thứ ba trong repo; ghim bằng sha256 | Vendor jar 3,7 MB: phình repo, phải tự rà license từng bản |
