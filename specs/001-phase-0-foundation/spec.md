# Feature Specification: Phase 0 — Khung dự án (project foundation)

**Feature Branch**: `001-phase-0-foundation` (làm trên nhánh `claude/phase-0-planning-tech-stack-6m4j5c`; đặt `SPECIFY_FEATURE=001-phase-0-foundation`)
**Created**: 2026-09-28
**Status**: Implemented — chờ CI xác nhận DoD
**Input**: `docs/ROADMAP.md` — Phase 0; `docs/SPEC.md` §2, §4.2, §19, §21

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Một lệnh khởi động cả hệ thống khung (Priority: P1)

Là developer của coral, tôi clone repo, chạy `pnpm install && pnpm dev` và có ngay server, web và agent chạy cùng lúc, nói chuyện được với nhau, để các phase sau chỉ việc thêm tính năng.

**Why this priority**: Là DoD đầu tiên của Phase 0; mọi phase sau đều cần vòng dev này.

**Independent Test**: Chạy `pnpm dev` trên máy sạch (không cần Docker) → `curl localhost:3000/health` trả `status: ok`; mở `localhost:5173` thấy trạng thái server; log agent có dòng `server reachable`.

**Acceptance Scenarios**:

1. **Given** repo vừa clone và Node 24, **When** chạy `pnpm install && pnpm dev`, **Then** server nghe ở :3000, web ở :5173, agent chạy và không process nào thoát.
2. **Given** `pnpm dev` đang chạy, **When** mở web, **Then** trang hiển thị phiên bản server lấy qua `/api/health` (proxy của Vite).
3. **Given** server chưa chạy, **When** agent khởi động, **Then** agent ghi một cảnh báo `server unreachable` và thử lại định kỳ, không crash, không spam log.

---

### User Story 2 - Cổng chất lượng xanh (Priority: P1)

Là developer, tôi chạy `pnpm lint`, `pnpm typecheck`, `pnpm test` và nhận kết quả xanh trên code khung, với TypeScript strict, để mọi thay đổi sau này có lưới an toàn.

**Why this priority**: DoD yêu cầu `pnpm test` xanh và CI xanh.

**Independent Test**: Chạy lần lượt ba lệnh trên ở gốc repo; tất cả exit 0.

**Acceptance Scenarios**:

1. **Given** code khung, **When** chạy `pnpm test`, **Then** Vitest chạy test của mọi gói và `scripts/`, tất cả pass.
2. **Given** một file `*.device.test.ts`, **When** chạy `pnpm test`, **Then** file đó bị bỏ qua; **When** chạy `pnpm test:device`, **Then** chỉ các file đó chạy.
3. **Given** code có promise bị bỏ quên, **When** chạy `pnpm lint`, **Then** ESLint báo lỗi (`no-floating-promises`).

---

### User Story 3 - Luật P1 được máy kiểm tra (Priority: P1)

Là chủ dự án, tôi muốn chắc chắn agent/runner không bao giờ dính tới LLM, kể cả gián tiếp, để nguyên tắc "AI viết, script chạy" không bị phá vỡ âm thầm.

**Why this priority**: P1 là nguyên tắc bất biến số một; ROADMAP yêu cầu luật này ngay ở Phase 0.

**Independent Test**: Thêm `"openai"` vào dependencies của `apps/agent` rồi chạy `pnpm check:boundaries` → exit 1 với thông báo rõ ràng. Thêm `import '@coral/brain'` vào `apps/agent/src` → `pnpm lint` báo lỗi.

**Acceptance Scenarios**:

1. **Given** gói khác `@coral/brain` khai báo LLM SDK, **When** chạy `pnpm check:boundaries`, **Then** báo vi phạm và exit 1.
2. **Given** gói khác `@coral/server` phụ thuộc `@coral/brain` (trực tiếp hoặc qua gói workspace khác), **When** chạy kiểm tra, **Then** báo vi phạm kèm chuỗi phụ thuộc.
3. **Given** một thư viện bên thứ ba kéo theo LLM SDK vào agent, **When** chạy kiểm tra (đọc `pnpm-lock.yaml`), **Then** báo vi phạm.
4. **Given** file TS trong `apps/agent` import LLM SDK hoặc `@coral/brain`, **When** chạy ESLint, **Then** báo lỗi `no-restricted-imports`.

---

### User Story 4 - Hạ tầng dev một lệnh (Priority: P2)

Là developer, tôi chạy `docker compose up -d` và có Postgres, Redis, MinIO sẵn sàng (healthy) cho Phase 1.

**Independent Test**: `docker compose up -d --wait` exit 0; `docker compose ps` cho thấy 3 dịch vụ `healthy`.

**Acceptance Scenarios**:

1. **Given** Docker, **When** chạy `docker compose up -d --wait`, **Then** `postgres`, `redis`, `minio` đều healthy.
2. **Given** `.env` ghi đè port/mật khẩu, **When** khởi động, **Then** compose dùng giá trị trong `.env`.

---

### User Story 5 - CI trên GitHub Actions (Priority: P2)

Là chủ dự án, mỗi lần push/PR tôi thấy CI chạy format, lint, kiểm tra ranh giới, typecheck, test, build và dựng thử docker compose.

**Independent Test**: Push nhánh → workflow `CI` có 2 job `checks` và `infra` đều xanh.

---

### User Story 6 - Quy trình spec-driven sẵn sàng (Priority: P3)

Là chủ dự án, tôi dùng Spec Kit (`/speckit-*`) cho các phase sau, với constitution phản ánh P1–P6 và `CLAUDE.md` có đủ lệnh thường dùng.

**Independent Test**: `.specify/` và `.claude/skills/speckit-*/SKILL.md` tồn tại; `.specify/memory/constitution.md` chứa P1–P6; `CLAUDE.md` mục "Lệnh thường dùng" đã điền.

### Edge Cases

- Port 3000/5173 bị chiếm → server báo lỗi `EADDRINUSE` và thoát với mã khác 0 (không treo).
- Biến môi trường sai kiểu (ví dụ `CORAL_SERVER_PORT=abc`) → service thoát ngay với thông báo liệt kê biến sai (Zod).
- Không có file `.env` → dùng giá trị mặc định dev, không lỗi.
- MinIO image community ngừng cập nhật (SPEC R8) → chỉ dùng S3 API chuẩn; đổi image không cần sửa code.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Repo MUST là monorepo pnpm workspaces + Turborepo với các gói `apps/server`, `apps/web`, `apps/agent`, `packages/shared`, `packages/brain`, `packages/cli` và thư mục `fixtures/`, `examples/`, `docs/`.
- **FR-002**: `pnpm dev` MUST khởi động server, web, agent song song; server MUST có `GET /health` trả payload theo `healthResponseSchema` của `packages/shared`.
- **FR-003**: Mọi dữ liệu từ bên ngoài (biến môi trường, response HTTP) MUST được validate bằng Zod.
- **FR-004**: TypeScript MUST ở chế độ strict (kèm `noUncheckedIndexedAccess`); ESLint type-aware và Prettier MUST chạy được trên toàn repo.
- **FR-005**: `pnpm test` MUST chạy Vitest cho mọi gói và bỏ qua `*.device.test.ts`; `pnpm test:device` MUST chỉ chạy các file đó.
- **FR-006**: Luật ranh giới D08 MUST được kiểm tra bằng `pnpm check:boundaries` (manifest + lockfile bắc cầu) và ESLint `no-restricted-imports`.
- **FR-007**: `compose.yaml` MUST định nghĩa `postgres`, `redis`, `minio` có healthcheck và volume bền.
- **FR-008**: CI MUST chạy format check, lint, boundaries, typecheck, test, build và job dựng docker compose.
- **FR-009**: `CLAUDE.md` MUST có mục "Lệnh thường dùng"; SPEC §19 và §21 MUST ghi tech stack đã chốt.
- **FR-010**: Spec Kit MUST được cài (`.specify/`, skill `/speckit-*` cho Claude Code) với constitution từ P1–P6.
- **FR-011**: `packages/brain` MUST chỉ là khung (chưa có adapter, chưa phụ thuộc LLM SDK).

### Key Entities

Không có entity dữ liệu ở Phase 0 (bảng DB bắt đầu ở Phase 1). Contract duy nhất: `HealthResponse` (`status`, `service`, `version`, `uptime_sec`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Từ repo sạch, `pnpm install && pnpm dev` đưa cả 3 service lên trong < 30 giây trên máy dev thông thường.
- **SC-002**: `pnpm test` xanh, 0 test bị skip ngoài `*.device.test.ts`.
- **SC-003**: `docker compose up -d --wait` đưa 3 dịch vụ về trạng thái healthy trong < 3 phút.
- **SC-004**: Workflow CI xanh trên commit cuối của nhánh.
- **SC-005**: 100% vi phạm D08 trong bộ test của `scripts/boundaries.test.ts` bị phát hiện.

## Clarifications

### Session 2026-09-28

- Q: `pnpm dev` có cần Docker không? → A: Không. Khung Phase 0 không kết nối DB/Redis/MinIO; hạ tầng dùng từ Phase 1.
- Q: `packages/brain` ở Phase 0 có interface chưa? → A: Chưa; chỉ khung + danh sách provider. Interface §14.1 phụ thuộc `ElementNode` (Phase 1) nên làm ở Phase 3.
- Q: "Tag `@device`" cho Vitest nghĩa là gì? → A: Quy ước tên file `*.device.test.ts` (D21).
- Q: Luật P1 áp dụng cho gói nào? → A: Tổng quát hóa thành D08 (chỉ brain dùng LLM SDK, chỉ server dùng brain, app không import app).
- Q: Tech stack §19? → A: Chốt theo `research.md` §1 và SPEC §19 (D07).
