# Implementation Plan: Phase 2 — Web UI, live view, recorder

**Branch**: `claude/phase-0-planning-tech-stack-6m4j5c` (feature `003-phase-2-web-recorder`) | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-phase-2-web-recorder/spec.md`

## Summary

Thao tác thiết bị và ghi test case từ trình duyệt, không cần viết YAML bằng tay, rồi chạy lại tất định như Phase 1:
1. **Web** (`apps/web`) — đăng nhập, project, thiết bị, run (ảnh từng step, cập nhật trực tiếp), editor YAML có ảnh.
2. **Live view + điều khiển** — agent chụp JPEG 2–5 khung/giây qua u2, gửi binary frame; server fan-out cho người xem trong tenant; điều khiển cần lease `live` (D16), lệnh qua `WS /ws/ui`.
3. **Recorder** — mỗi click trên live view: agent chọn element theo hit-test D36, trích **toàn bộ** chuỗi locator từ cây (không AI), cắt ảnh, lưu snapshot, tap tâm element, đề xuất kỳ vọng; lưu = một commit YAML + `snap/`.
4. **Locator `image`** — OpenCV WASM trong runner (D27), nạp lười.

Hướng kỹ thuật: logic ghi thuần trong `packages/runner/src/core/recorder/` (agent chạy — web không import runner); giao thức UI mới `protocol/ui.ts` trong shared; server thêm `live/` (phiên điều khiển, `StreamHub`), `recordings/`, WS `/ws/ui`; agent thêm `DeviceSessions` dùng chung một u2 cho job + stream + lệnh. DoD chạy bằng Playwright trên emulator Android 14 của CI (Phase 1 cho thấy emulator bắt lỗi mà FakeDriver bỏ sót — D36).

Chi tiết: [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict), Node.js 24 LTS, ESM; trình duyệt Chrome/Edge/Firefox bản mới

**Primary Dependencies** (mới):
- `apps/web`: `@tanstack/react-router`, `tailwindcss` 4 + `@tailwindcss/vite`, `@codemirror/state|view|lang-yaml|lint`, `@testing-library/react` + `jsdom` (test)
- `packages/runner`: `@techstark/opencv-js` (template matching, nạp lười), `fast-png` (giải mã/cắt/ghi PNG thuần JS)
- repo gốc (dev): `@playwright/test` (E2E, dùng Chromium có sẵn)
- Không thêm phụ thuộc cho server/agent ngoài những gì đã có (ws, fastify websocket, S3, simple-git)

**Storage**: như Phase 1; thêm bảng `live_sessions`, `device_commands`, `recordings`; S3 `recordings/…`, `assets/<sha256>`; repo project thêm `snap/<slug>/<step_id>/` (ảnh nhị phân)

**Testing**: Vitest (unit, `*.int.test.ts`), component web với Testing Library + jsdom, **Playwright E2E** (`pnpm test:e2e`, file `e2e/*.e2e.ts` ở gốc) với server + agent thật + FakeDriver vẽ ảnh; 🔌 cùng kịch bản trên emulator CI (`device.yml`)

**Target Platform**: như Phase 1; web desktop

**Project Type**: monorepo — web SPA + web service + daemon + CLI + thư viện runner

**Performance Goals**: live view ≤ 3 s để có khung đầu, ≥ 2 fps, click → hình mới ≤ 2 s ở p90 (SC-002); trang run 10 step ≤ 3 s (SC-009); lưu ≤ 2 s; template matching ≤ 1 s trên ảnh 1080×2400

**Constraints**: P1 (không AI trong recorder/runner/agent), P2 (locator lấy từ cây, `point_pct` cuối), P5 (mọi luồng WS/stream/lệnh kiểm tenant), P6 (danh sách lệnh đóng, cảnh báo `never_tap`), secret không đi qua trình duyệt (FR-014, D19), web không import runner/brain (SPEC §5), một u2 mỗi thiết bị

**Scale/Scope**: ≤ 10 thiết bị, ≤ 5 người xem một thiết bị, 1 phiên điều khiển/thiết bị; ~10 màn hình web; 7 user story

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Thiết kế Phase 2 | Trước research | Sau design |
|---|---|---|---|
| I. AI viết, script chạy (P1) | Recorder, đề xuất kỳ vọng, image matcher đều tất định trong `packages/runner` (không LLM); `no-ai.test.ts` (T065) tự phủ phụ thuộc mới của runner/agent/cli (`opencv-js`, `fast-png` không phải LLM/MCP SDK). `apps/web` không import `@coral/runner`/`@coral/brain` (thêm luật ESLint). | PASS | PASS |
| II. Locate, don't memorise (P2) | Mọi locator trích từ cây và được kiểm lại bằng resolver trước khi giữ; locator đầu luôn khớp lúc ghi; `point_pct` chỉ khi không locator có cấu trúc nào khớp, luôn ở cuối; tap khi ghi vào tâm element (giống chạy lại). | PASS | PASS |
| III. No blind healing (P3) | Phase 2 không sửa test case tự động; đề xuất kỳ vọng chỉ thêm khi người dùng chọn; lưu từ Recorder/editor là thao tác của người. | PASS | PASS |
| IV. Provider-neutral knowledge (P4) | Test case + snapshot + ảnh locator là file thuần trong repo project (`snap/`). | PASS | PASS |
| V. Tenant isolation (P5) | Bảng mới có `tenant_id`, qua repository có tenant scope; `/ws/ui` xác thực bằng access token, mọi subscribe/lệnh kiểm thiết bị cùng tenant; key S3 do server sinh dưới `<tenant_id>/`; vai trò viewer bị chặn ở server (FR-002a). | PASS | PASS |
| VI. Safe operation (P6) | Lệnh điều khiển là danh sách đóng (không shell tùy ý); `restart_app`/`prepare` chỉ đụng package đang test; Recorder cảnh báo nút `never_tap`; popup guard không tự bấm gì khi đang điều khiển tay. | PASS | PASS |
| Ràng buộc kỹ thuật | Zod cho message UI/agent mới, DTO REST, header khung hình; `snake_case` trên dây; migration Drizzle mới; E2E tách khỏi unit. | PASS | PASS |

Không có vi phạm; lựa chọn làm tăng độ phức tạp ghi ở Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/003-phase-2-web-recorder/
├── plan.md
├── research.md                 # R1–R15
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api-phase2.md      # route mới + vai trò
│   ├── ui-ws.md                # WS /ws/ui (trình duyệt ↔ server)
│   ├── agent-ws-phase2.md      # stream.*, device.command, job.assign.assets
│   ├── web-ui.md               # màn hình và hành vi
│   └── testcase-image-locator.md
├── checklists/requirements.md
└── tasks.md                    # /speckit-tasks
```

### Source Code (repository root)

```text
packages/shared/src/
├── protocol/ui.ts              # MỚI: envelope UI, message, DeviceCommand
├── protocol/frame.ts           # MỚI: đóng/mở binary frame (header JSON + ảnh)
├── protocol/messages.ts        # + stream.*, device.command(_result), job.assign.items[].assets
├── testcase/schema.ts          # locator image dạng object; validate.ts: image_path_invalid, image_not_found, image_in_expect
├── api/                        # + devices activity, control, recordings, snapshots
└── recording.ts                # MỚI: RecordingStep, sinh YAML từ steps

packages/runner/src/
├── core/recorder/              # MỚI: pick.ts (element đích), locators.ts (chuỗi locator), suggest.ts (kỳ vọng), crop.ts
├── core/image/                 # MỚI: matcher.ts (interface), opencv.ts (nạp lười @techstark/opencv-js), png.ts (fast-png)
├── core/run-testcase.ts        # resolveTarget() bất đồng bộ: thử image theo thứ tự chuỗi
├── drivers/android/android-driver.ts   # + streamFrame() (u2 takeScreenshot → JPEG, fallback PNG)
└── testing/render.ts           # MỚI: vẽ ElementNode[] thành PNG cho FakeDriver (E2E, demo)

packages/cli/src/commands/run.ts        # --project-root cho ảnh locator

apps/agent/src/
├── device-sessions.ts          # MỚI: một UiDriver/u2 mỗi thiết bị, dùng chung, đóng khi rảnh
├── streamer.ts                 # MỚI: stream.start/stop → khung hình
├── commands.ts                 # MỚI: device.command (lệnh, prepare, record, inspect)
└── jobs.ts                     # lấy driver từ DeviceSessions; tải assets theo sha256

apps/server/src/
├── ui/gateway.ts               # MỚI: WS /ws/ui (auth, subscribe, dispatch)
├── live/stream-hub.ts          # MỚI: người xem ↔ stream.start/stop, fan-out, bỏ khung người chậm
├── live/control.ts             # MỚI: phiên điều khiển, lease live, lệnh → agent, audit device_commands
├── recordings/                 # MỚI: service (bắt đầu/ghi/dừng/lưu), dọn bản ghi hết hạn
├── runs/dispatcher.ts          # + assets cho job.assign
├── git/project-repo-store.ts   # commitFiles nhận Buffer; đọc file nhị phân
├── auth/guard.ts               # requireRole
├── routes/                     # devices (control), recordings, testcases (snapshots, files, last-run-steps)
└── db/migrations/              # 000N_phase2.sql

apps/web/src/
├── routes/                     # cây route TanStack Router (contracts/web-ui.md)
├── api/                        # client REST (refresh 401 một lần), ws.ts (kết nối /ws/ui, auth, subscribe)
├── components/                 # LiveView (canvas, quy đổi tọa độ), StepList, YamlEditor, RunSteps…
├── features/recorder/          # Recorder page, đề xuất kỳ vọng, chọn secret
└── i18n/en.ts

e2e/                            # MỚI: Playwright (*.e2e.ts) + fixture khởi động server/agent/fake device
fixtures/images/                # MỚI: ảnh màn hình + ảnh cắt cho test image matcher
.github/workflows/ci.yml        # + job E2E (Playwright, Chromium)
.github/workflows/device.yml    # + DoD Recorder trên emulator
```

**Structure Decision**: giữ monorepo; không thêm gói mới — recorder và image matcher là module của `packages/runner` (agent và `coral run` dùng chung), giao thức UI ở `packages/shared` (web + server dùng chung). E2E ở thư mục gốc `e2e/` vì khởi động nhiều app (như `scripts/` ở Phase 1, D08).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Kênh WS thứ hai (`/ws/ui`) bên cạnh `/ws/agent` | Trình duyệt cần sự kiện run, khung hình, lệnh điều khiển hai chiều | Polling REST: không đạt 2 fps / 2 s; SSE: không gửi lệnh được |
| `DeviceSessions` dùng chung u2 | Hai u2 trên một thiết bị làm server kia mất UiAutomation (thấy ở CI Phase 1) | Driver riêng cho stream: xung đột; stream bằng adb PNG: 1–2 MB/khung |
| Bản ghi ở server (`recordings`) thay vì chỉ trong trình duyệt | Snapshot phải lưu trước khi thành test case; không mất khi tải lại/đổi máy (FR-016) | `localStorage`: không chứa được ảnh, mất khi đổi máy |
| Playwright E2E + FakeDriver vẽ ảnh | DoD là luồng trên trình duyệt; unit/component không bắt được lỗi tích hợp WS + canvas + tọa độ | Chỉ test tay: không lặp lại được, không chụp ảnh tự động |
| OpenCV WASM (~9 MB) trong runner | SPEC §19/D27 chọn; `matchTemplate` chuẩn, nhanh hơn tự viết | Tự viết NCC bằng JS: chậm (ảnh 1080×2400), dễ sai |
