---

description: "Task list for Phase 2 — web UI, live view, recorder"
---

# Tasks: Phase 2 — Web UI, live view, recorder

**Input**: Design documents from `specs/003-phase-2-web-recorder/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: CÓ — CLAUDE.md yêu cầu mỗi task kèm test. Bốn loại:
- `*.test.ts(x)` — unit / component (jsdom), CI mặc định.
- `*.int.test.ts` — cần Postgres/Redis/MinIO (`pnpm test:int`, D34).
- `e2e/*.e2e.ts` — Playwright + server + agent + FakeDriver vẽ ảnh (`pnpm test:e2e`, job CI riêng).
- 🔌 `*.device.test.ts` / bước trong `.github/workflows/device.yml` — emulator Android 14 của CI (D21).

**Organization**: theo US1–US7 của spec.md. Mỗi task là một commit nhỏ (code + test). Sau mỗi user story: chụp màn hình giao diện (Playwright) gửi Huynh.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: chạy song song được (khác file, không phụ thuộc task chưa xong)
- **[Story]**: US1–US7 theo spec.md
- 🔌: kiểm trên emulator CI

## Path Conventions

Monorepo (plan.md → Project Structure): `apps/web/src/`, `apps/server/src/`, `apps/agent/src/`, `packages/shared/src/`, `packages/runner/src/`, `packages/cli/src/`, `e2e/`, `fixtures/`, `scripts/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: thư viện, quy ước test E2E, luật phụ thuộc

- [x] T001 Thêm phụ thuộc web vào `apps/web/package.json`: `@tanstack/react-router`, `tailwindcss` 4 + `@tailwindcss/vite`, `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-yaml`, `@codemirror/lint`; dev: `@testing-library/react`, `@testing-library/user-event`, `jsdom`; cấu hình Tailwind trong `apps/web/vite.config.ts` + `src/styles.css`; `apps/web/vitest.config.ts` dùng `environment: 'jsdom'` cho `*.test.tsx`; Vite proxy thêm `ws: true` và `cookiePathRewrite: { '/auth': '/api/auth' }` (research R2); test `apps/web/src/app.test.tsx` render `App` trong jsdom
- [x] T002 [P] Luật phụ thuộc web: `apps/web` không import `@coral/runner`, `@coral/brain`, `node:*` — thêm vào `eslint.config.js` (`restrictedImports`) và `scripts/boundaries.mjs` (`checkManifests`: web không phụ thuộc runner/brain); test ca mới trong `scripts/boundaries.test.ts` và `scripts/eslint-boundaries.test.ts`
- [x] T003 [P] Thêm `@techstark/opencv-js` và `fast-png` vào `packages/runner/package.json`; `scripts/no-ai.test.ts` vẫn xanh (không phải LLM/MCP SDK) — test: closure của `@coral/runner` chứa `fast-png`
- [x] T004 Quy ước E2E: `@playwright/test` (dev, gốc repo), `playwright.config.ts` (Chromium: `executablePath` từ `PLAYWRIGHT_CHROMIUM` hoặc `/opt/pw-browsers/...` nếu có, không tải trình duyệt trong container), thư mục `e2e/`, script gốc `test:e2e`; `vitest.shared.ts` loại `e2e/**` khỏi mọi chế độ Vitest; job `e2e` trong `.github/workflows/ci.yml` (compose up → migrate → `npx playwright install chromium` → `pnpm test:e2e`, tải ảnh chụp lên artifact); test `scripts/test-selection.test.ts` ca `e2e/**` bị loại

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: giao thức, schema locator ảnh, DB, vai trò, WS UI, phiên thiết bị trên agent, nền web, fixture ảnh — mọi story cần

**⚠️ CRITICAL**: xong phase này mới làm user story

- [x] T005 [P] `packages/shared/src/protocol/frame.ts`: `encodeFrame(header, bytes)` / `decodeFrame(buf)` — `[uint32 BE độ dài header][header JSON UTF-8][ảnh]`, header Zod `{ type: "stream.frame", udid? , device_id?, seq, ts, width, height, device_width, device_height, rotation, mime: "image/jpeg"|"image/png" }`, tối đa 2 MB; chạy được trong trình duyệt (Uint8Array, không Buffer); test `frame.test.ts` (khứ hồi, header sai, quá lớn)
- [x] T006 [P] `packages/shared/src/protocol/ui.ts`: envelope UI + mọi message của contracts/ui-ws.md (`ui.auth`, `ui.ready`, `run.watch/unwatch`, `run.updated`, `run.step`, `devices.updated`, `stream.subscribe/unsubscribe`, `stream.status`, `live.command`, `live.result`, `live.inspect`, `live.inspected`, `recording.step`, `live.ended`, `error`) và `DeviceCommand` union (tọa độ pixel thiết bị; `type` có `text` **hoặc** `secret`); `parseUiMessage` như `parseMessage` Phase 1 (256 KB); test `ui.test.ts` (mỗi type hợp lệ + rỗng bị từ chối, `re` bắt buộc với trả lời)
- [x] T007 [P] `packages/shared/src/protocol/messages.ts`: thêm `stream.start` `{ udid, fps 2–5 (mặc định 4), max_edge 1280, quality 30–90 (mặc định 60) }`, `stream.stop`, `device.command` `{ command_id, udid, command }` (kind của contracts/agent-ws-phase2.md: lệnh, `prepare`, `record`, `inspect`), `device.command_result` (`re` bắt buộc), `job.assign.items[].assets: [{ path, sha256, download_url }]` (mặc định `[]`, tương thích Phase 1); test ca mới trong `protocol.test.ts`
- [x] T008 [P] `packages/shared/src/api/`: DTO của contracts/rest-api-phase2.md — `Device.activity`, control session, `Recording`, `RecordingStep` (data-model §3), snapshots, lỗi `forbidden`/`device_busy`/`slug_exists`/`image_not_found`; test `api.test.ts` ca mới
- [x] T009 [P] Shared (trước T010 — Recorder sinh locator ảnh, F1): schema `image: string | { path, threshold 0.5–1, screen_width }` (contracts/testcase-image-locator.md); `validateTestCase` gỡ lỗi "chưa hỗ trợ", thêm `image_path_invalid`, `image_in_expect`, `image_not_found` (khi có hàm `fileExists` truyền vào); fixture `fixtures/testcases/valid/image-locator.yaml` + `invalid/*` cho 3 mã mới + `expected.json`; test `validate.test.ts`
- [x] T010 `packages/shared/src/recording.ts`: kiểu `RecordingStep` + `recordingToYaml({ slug, intent, steps, preconditions })` sinh `coral/testcase@1` (id = slug, `preconditions.app_state: fresh`, platforms `[android]`, đường dẫn `image` dạng `snap/<slug>/<step_id>/element.png`, secret dạng `${secret:NAME}`); YAML sinh ra luôn qua `validateTestCaseSource`; test `recording.test.ts` (5 step có image, type secret, đổi slug đổi đường dẫn ảnh)
- [x] T011 [P] `packages/runner/src/testing/render.ts`: `renderTree(tree, size) → PNG` (fast-png) vẽ nền, khung node bấm được, chữ đơn giản (bitmap font 5×7 cho ASCII), màu theo package (dialog khác app) — cho FakeDriver.screenshot, demo và E2E; `FakeDriver` dùng `renderTree` khi `options.renderScreens` bật; test `render.test.ts` (PNG hợp lệ, đúng kích thước, pixel trong bounds nút khác nền)
- [x] T012 Fixture ảnh `fixtures/images/`: ảnh màn hình PNG 1080×2400 dựng từ `fixtures/android/login.xml` bằng `renderTree` (task ngay trước) + ảnh cắt nút `loginBtn`, biến thể nút đổi chữ/đổi id, màn hình không có nút; `README.md` ghi nguồn và kỳ vọng (SC-005)
- [x] T013 Migration `apps/server/src/db/migrations/000N_phase2` + `schema.ts` theo data-model §1: `leases.kind` thêm `live`, `recording`; `test_cases.source` thêm `recorder`; bảng `live_sessions` (end_reason ∈ released/idle_timeout/agent_offline/replaced_by_recording), `device_commands` (kind ∈ tap/long_press/swipe/type/back/home/hide_keyboard/restart_app/prepare/record/inspect; status ∈ sent/ok/failed/rejected; **không** có cột chữ đã gõ), `recordings` (status ∈ recording/stopped/saved/discarded/expired; `expires_at` = updated_at + 7 ngày); mọi bảng có `tenant_id not null`; test `schema.int.test.ts` ca mới (lease `live` và `run` cùng thiết bị → vi phạm unique)
- [x] T014 Vai trò (FR-002a, research R13): `apps/server/src/auth/guard.ts` thêm `requireRole(...roles)`; áp cho route ghi Phase 1 (`POST /runs`, `POST /runs/:id/cancel`, `POST /projects/:id/testcases`, `PUT /testcases/:id`, `PUT /projects/:id/popups`, `POST /apps/:id/builds`, `POST /projects`, `POST /projects/:id/apps`, `POST /agents`, `POST /agents/:id/revoke`) → 403 `forbidden` cho `viewer`; `test-server.ts` `newUser(name, role?)`; test `roles.int.test.ts` (viewer đọc được, ghi bị 403; member ghi được)
- [x] T015 `WS /ws/ui` — `apps/server/src/ui/gateway.ts`: nghe trước auth như gateway agent Phase 1, message đầu phải `ui.auth` trong 5 s (sai → 4401), `ui.auth` lại để gia hạn, >20 message sai/phút → 4400, registry kết nối theo tenant/user, API nội bộ `broadcastToTenant`, `sendTo(conn)`, `sendBinary`; đăng ký trong `services.ts`/`server.ts`; test `ui-gateway.int.test.ts` (auth đúng/sai/hết giờ, message sai, cô lập tenant) + helper `apps/server/src/testing/ui-client.ts`
- [x] T016 Phiên thiết bị trên agent (research R6): `apps/agent/src/device-sessions.ts` — một `RunnableDriver` mỗi thiết bị, `acquire(udid, { appId? })` / `release`, mở lười, đóng sau 60 s rảnh, đóng hết khi agent dừng; `JobManager` (`jobs.ts`) chuyển sang `DeviceSessions`; driver Android tách phần app: `createAndroidDriver({ udid, appId? })` và lifecycle theo app tạo khi có `appId`; test `device-sessions.test.ts` (dùng chung, đóng khi rảnh, job + phiên khác cùng thiết bị không mở u2 thứ hai) + `jobs.test.ts` vẫn xanh
- [x] T017 Nền web `apps/web/src/`: `router.tsx` (TanStack Router, route của contracts/web-ui.md, guard phiên → `/login?next=`), `api/client.ts` (tiền tố `/api`, access token trong bộ nhớ, 401 → refresh một lần rồi thử lại, refresh lỗi → login), `api/session.tsx` (khôi phục phiên bằng refresh khi tải trang), `api/ws.ts` (một kết nối `/api/ws/ui`, `ui.auth`, tự nối lại với backoff, gửi lại `ui.auth` sau refresh, đăng ký lại subscribe), `i18n/en.ts`, `components/Layout.tsx` (thanh điều hướng Projects · Devices · Runs, người dùng + vai trò, Sign out); test `client.test.ts` (401 → refresh → thử lại một lần), `ws.test.ts` (WebSocket giả: auth trước, nối lại, đăng ký lại)
- [x] T018 Launcher thiết bị giả cho dev/E2E: `scripts/dev-fake-device.ts` + script gốc `dev:fake-device` — agent thật + FakeDriver `renderScreens` với kịch bản app mẫu (catalog → menu → login → products, dialog quyền camera ở màn QR) tái dùng từ `scripts/fake-device-agent.ts`; `e2e/fixtures.ts` khởi động server (port ngẫu nhiên), `vite preview`, agent giả, user seed; test: `e2e/smoke.e2e.ts` mở trang đăng nhập

**Checkpoint**: nền xong — các story làm song song được.

---

## Phase 3: User Story 1 - Xem project, thiết bị và kết quả run trên web (Priority: P1)

**Goal**: đăng nhập, xem project/thiết bị/run, chạy test case từ web, cập nhật trực tiếp.

**Independent Test**: server + agent giả; đăng nhập web, mở run có sẵn → đủ step và ảnh; tạo run từ web → chạy xong hiện kết quả không cần tải lại (quickstart §2).

- [x] T019 [P] [US1] Server: `GET /devices` thêm `activity` (`idle|run|live|recording|offline`, `by`, `run_id`, `since` — từ lease mở); `GET /runs` thêm lọc `device_id`, `test_case_id`; test `devices.int.test.ts`, `runs-list.int.test.ts` ca mới
- [x] T020 [US1] Server đẩy sự kiện: ingest (`runs/ingest.ts`) và dispatcher phát `run.updated` / `run.step` tới kết nối UI đã `run.watch` (cùng tenant); đổi lease/thiết bị → `devices.updated` cho cả tenant; test `ui-run-events.int.test.ts` (agent giả chạy run → UI client nhận đúng thứ tự; tenant khác không nhận)
- [x] T021 [P] [US1] Web `routes/login.tsx`: form, lỗi chung "Invalid email or password", `next`; test component (submit, lỗi)
- [x] T022 [P] [US1] Web `routes/projects/*`: danh sách + tạo project ✍; trang project với tab Test cases, Runs, Recordings và danh sách app/build chỉ đọc (FR-003; tạo app, tải build ở US7); test component (loading/empty/error)
- [x] T023 [P] [US1] Web `routes/devices.tsx`: bảng thiết bị + trạng thái `activity`, cập nhật qua `devices.updated`; test component
- [x] T024 [US1] Web `routes/runs/*`: danh sách run (lọc, cập nhật trực tiếp) và chi tiết run: step (ảnh presigned, trạng thái, locator đã dùng + `degraded`, thời gian, popup, lỗi + device log, xem `tree.json` dạng cây), `run.watch`; test component với dữ liệu mẫu
- [x] T025 [US1] Web chạy test case: nút **Run** ✍ trên một test case, hoặc chọn nhiều test case ở tab Test cases (FR-004) → chọn build + thiết bị → `POST /runs` → chuyển tới chi tiết run; ẩn với viewer; test component
- [x] T026 [US1] E2E `e2e/us1-runs.e2e.ts`: đăng nhập, tạo run trên thiết bị giả, trang run tự cập nhật tới `passed`, ảnh step hiện; user tenant khác mở URL → Not found; SC-009: trang chi tiết run 10 step hiện đủ ảnh trong ≤ 3 s; chụp ảnh `e2e-results/us1-*.png`

**Checkpoint**: US1 xong — web thay được việc gọi API tay.

---

## Phase 4: User Story 2 - Xem màn hình thiết bị trực tiếp (Priority: P1)

**Goal**: live view 2–5 fps cho mọi người xem cùng tenant, cả khi đang chạy run.

**Independent Test**: hai trình duyệt mở cùng thiết bị giả → cả hai thấy khung hình mới; run chạy → vẫn xem được (quickstart §3).

- [x] T027 [P] [US2] Runner: `AndroidDriver.streamFrame({ maxEdge, quality })` — u2 `takeScreenshot(scale, quality)` → JPEG (base64 → bytes), fallback `screencap -p` (PNG) khi phương thức không có; kích thước khung + kích thước thiết bị; `FakeDriver.streamFrame` trả PNG của `renderTree`; test `android-driver.test.ts` (JSON-RPC giả trả base64, fallback) + 🔌 `android-driver.device.test.ts` ca "stream frame là JPEG ≤ 300 KB trong ≤ 1 s"
- [x] T028 [US2] Agent `apps/agent/src/streamer.ts`: `stream.start/stop` → vòng lặp một khung một lúc theo fps, `encodeFrame` gửi binary qua `connection.sendBinary`, dừng khi thiết bị biến mất/agent dừng; `connection.ts` thêm gửi binary; test `streamer.test.ts` (FakeClock: đúng nhịp, không xếp hàng khi gửi chậm, dừng sạch)
- [x] T029 [US2] Server `apps/server/src/live/stream-hub.ts`: người xem theo thiết bị (cùng tenant), người đầu → `stream.start`, người cuối/ngắt → `stream.stop`, nhận binary từ gateway agent (kiểm udid thuộc agent), đổi `udid` → `device_id`, fan-out, bỏ khung khi `bufferedAmount` > 1 MB, `stream.status` (`stalled` sau 5 s không khung, `stopped` khi agent mất); gateway agent chấp nhận binary frame; test `stream-hub.test.ts` (unit, socket giả) + `stream.int.test.ts` (agent giả gửi khung → 2 UI client nhận, client tenant khác bị từ chối, người chậm bị bỏ khung)
- [x] T030 [US2] Web `components/LiveView.tsx`: đăng ký stream, vẽ canvas bằng `createImageBitmap`, bỏ khung cũ, fps hiển thị, lớp phủ "Connection lost — reconnecting" khi `stalled`, giữ tỉ lệ; trang `routes/devices.$deviceId.tsx`; test component (khung giả → vẽ; stalled → lớp phủ)
- [x] T031 [US2] E2E `e2e/us2-live.e2e.ts`: hai context trình duyệt xem cùng thiết bị giả → cả hai nhận ≥ 2 khung/giây trong 3 s; chạy run → vẫn xem được; chụp ảnh

**Checkpoint**: US2 xong.

---

## Phase 5: User Story 3 - Điều khiển thiết bị từ trình duyệt (Priority: P1)

**Goal**: giữ thiết bị bằng lease `live`, chạm/vuốt/gõ từ web, thả tay hoặc tự thả.

**Independent Test**: giữ thiết bị giả, click nút → màn hình đổi; tạo run khi đang giữ → chờ; thả → run chạy (quickstart §3).

- [x] T032 [US3] Server `apps/server/src/live/control.ts` + route `apps/server/src/routes/devices-control.ts`: `POST/GET/DELETE /devices/:id/control` ✍ (lease `live`, `holder_ref live:<id>`, 409 `device_busy` kèm `activity`, 409 `device_offline`), `live.command` từ `/ws/ui` chỉ của người giữ → `device.command` tới agent → `live.result` (`re`), gia hạn `expires_at` mỗi lệnh (`CORAL_LIVE_IDLE_MS`, mặc định 600000), sweeper Phase 1 thả khi quá hạn + `live.ended idle_timeout`, agent offline → `agent_offline`; ghi `device_commands` (params **không** chứa chữ gõ — chỉ `length`/`secret`); lệnh `type` với `secret` → server điền giá trị từ `SecretSource` (không gửi về web); `CORAL_LIVE_IDLE_MS` đọc qua schema env Zod của server; test `control.int.test.ts` (run chờ khi đang giữ rồi chạy sau khi thả; idle timeout; `not_holder`; viewer 403; audit không có chữ gõ; hai người cùng bấm giữ đồng thời → đúng một người giữ, người kia 409 — SC-006; user tenant khác không giữ được, không gửi lệnh được tới thiết bị — SC-007)
- [x] T033 [P] [US3] Agent `apps/agent/src/commands.ts`: `device.command` các lệnh `tap`, `long_press`, `swipe`, `type` (redact trong log), `back`, `home`, `hide_keyboard`, `restart_app` (chỉ package được truyền — P6) qua `DeviceSessions`; lệnh không hỗ trợ → `ok: false`; test `commands.test.ts` (FakeDriver: mỗi lệnh gọi đúng driver; log không chứa chữ gõ)
- [x] T034 [US3] Web điều khiển trong `LiveView`: **Take control**/**Release**, "Controlled by …", click → tap, kéo → swipe, giữ ≥ 500 ms → long press (quy đổi tọa độ theo khung đang hiển thị — contracts/ui-ws.md), nút Back/Home/Hide keyboard/Restart app, ô **Type text** + Enter, chọn secret cho ô mật khẩu, đếm ngược tự thả; ẩn với viewer; test `coords.test.ts` (quy đổi, xoay) + component
- [x] T035 [US3] E2E `e2e/us3-control.e2e.ts`: giữ thiết bị giả, click "View menu" → menu mở; context thứ hai thấy "Controlled by"; tạo run → `queued` → Release → run chạy; SC-002: ≥ 90% cú click cho khung hình mới trong ≤ 2 s (đo trên 20 click); chụp ảnh

**Checkpoint**: US3 xong.

---

## Phase 6: User Story 4 - Ghi test case bằng Recorder (Priority: P1) 🎯 DoD

**Goal**: ghi flow trên web, trích locator từ cây, snapshot, đề xuất kỳ vọng, lưu thành một commit, chạy lại 3/3.

**Independent Test**: ghi 5 step trên thiết bị giả (E2E) và trên emulator CI (🔌), lưu, chạy lại 3/3 (quickstart §4).

- [x] T036 [P] [US4] Runner `core/recorder/pick.ts`: element đích = element nhận chạm `touchTargetAt` (D36) nếu bấm được, không thì element bấm được nhỏ nhất chứa điểm (FR-011, research R8.1); test `pick.test.ts` trên `fixtures/android/*` (chữ trong nút → nút; logo đè menu → menu; ngoài app → cửa sổ trên cùng)
- [x] T037 [P] [US4] Runner `core/recorder/locators.ts`: ứng viên theo §7.2 (`android_id`, `text`, `desc`, `rel` với nhãn gần nhất, `class_index` trong tổ tiên có id, `image`, `point_pct`), giữ ứng viên chỉ khi `resolve([c], tree)` trả đúng element (research R8.3), `image` luôn có cho step chạm, `point_pct` cuối và chỉ khi không ứng viên cấu trúc nào đạt; test `locators.test.ts` — **SC-004**: mọi nút bấm được trong mọi fixture có ≥ 2 locator và locator đầu khớp đúng element
- [ ] T038 [P] [US4] Runner `core/recorder/suggest.ts`: `suggestExpects(before, after)` — chữ mới (bỏ ≤ 2 ký tự, số thuần, status bar), element có id mới → `visible`, id biến mất → `not_visible`, tối đa 3, mỗi đề xuất qua `checkExpect` trên cây sau (research R9); test `suggest.test.ts` (login → products; mở menu; không đổi gì → rỗng)
- [ ] T039 [P] [US4] Runner `core/recorder/crop.ts` (+ `core/image/png.ts`): cắt vùng bounds từ PNG/JPEG màn hình thành `element.png` (fast-png; JPEG từ `takeScreenshot` giải mã bằng `screenshot()` PNG thay thế khi cần); test `crop.test.ts` với ảnh `renderTree`
- [ ] T040 [US4] Agent `commands.ts`: `prepare` (cài build nếu sha khác, `pm clear`, mở app, chờ ổn định, snapshot), `record` (research R8: cây ổn định → pick → locators → snapshot `screen.jpg`/`tree.json` (che secret)/`element.png` → PUT presigned → thực hiện thao tác ở tâm element → chờ ổn định → `suggestExpects`; popup khớp luật → làm nhưng trả `popup_rule`, không step; `never_tap` → `warnings`), `inspect` (không chạm); test `commands.test.ts` ca mới (FakeDriver `renderScreens`: record từng loại `tap`, `long_press`, `swipe`, `type`, `back`, `hide_keyboard` tạo đúng step — FR-013; popup quyền không thành step; secret không có trong tree.json)
- [ ] T041 [US4] Server `apps/server/src/recordings/service.ts` + `routes/recordings.ts` theo contracts/rest-api-phase2.md: `POST /recordings` ✍ (lease `recording`, chuyển phiên `live` của cùng người sang ghi, `prepare`), `GET`, `PATCH` (steps qua Zod), `stop`, `resume`, `yaml`, `DELETE`; `live.command` với `record: true` → `device.command record` với presigned PUT dưới `<tenant>/recordings/<id>/<n>/` → nối step vào `recordings.steps` → `recording.step` qua `/ws/ui`; chữ gõ ô thường trùng giá trị secret → `secret_hint { name }` (không gửi giá trị); ô mật khẩu mà web gửi `text` thay vì `secret` → từ chối `secret_required`; test `recordings.int.test.ts` (agent giả: start → 3 step → PATCH → yaml hợp lệ; tenant khác 404; viewer 403)
- [ ] T042 [US4] Lưu bản ghi: `ProjectRepoStore.commitFiles` nhận `Buffer` + xóa thư mục trong cùng commit; `POST /recordings/:id/save` ✍ — validate như Phase 1 + ảnh tham chiếu phải có trong bộ file sắp commit, một commit YAML + `snap/<slug>/<step_id>/{screen.jpg,tree.json,element.png}` chép từ S3, `test_cases.source = recorder`, 409 `slug_exists` trừ khi `replace: true` + `base_commit`; test `recordings-save.int.test.ts` (một commit, đủ file, YAML lỗi không commit gì)
- [ ] T043 [P] [US4] Dọn bản ghi: job định kỳ đánh dấu `expired` bản ghi quá `expires_at` và xóa object S3 dưới `recordings/<id>/`; test `recordings-expiry.int.test.ts`
- [ ] T044 [US4] Web Recorder `apps/web/src/features/recorder/`: chọn app/build/thiết bị → `POST /recordings`, live view + điều khiển (US3) gửi `record: true`, danh sách step (ảnh nhỏ, action, locator đầu, cảnh báo, xóa, kéo sắp xếp → `PATCH`), chip **đề xuất kỳ vọng** (FR-013a), chế độ **Assert** (`live.inspect` → thêm `visible`/`visible_text`/`not_visible`), gợi ý secret, thông báo "Handled by popup rule <rule> — not recorded" khi thao tác vào popup có luật (FR-015), slug + intent, **Preview YAML** (chỉ xem; sửa YAML tự do trong editor sau khi lưu — FR-016), **Save as test case** → mở editor; khôi phục khi tải lại; test component (step đến → danh sách; chip → PATCH; save lỗi hiện đúng step)
- [ ] T045 [US4] E2E `e2e/us4-recorder.e2e.ts` (DoD mô phỏng): ghi 5 step trên thiết bị giả (mở app, menu, Log In, gõ user, gõ password bằng secret, Login, chấp nhận một đề xuất kỳ vọng), lưu `recorded-login`, chạy lại 3 lần → 3/3 `passed`; YAML không chứa giá trị secret; SC-009: lưu ≤ 2 s; chụp ảnh từng bước
- [ ] T046 [US4] 🔌 DoD trên emulator: `.github/workflows/device.yml` + `scripts/ci-device.sh` chạy `e2e/us4-recorder.e2e.ts` với `CORAL_E2E_DEVICE=emulator` (server + agent thật + My Demo App) → 3/3 `passed`, ảnh giao diện vào artifact; ghi kết quả vào quickstart §4 (SC-001)

**Checkpoint**: US4 xong — DoD Phase 2.

---

## Phase 7: User Story 5 - Sửa test case trong editor có ảnh từng step (Priority: P2)

**Goal**: editor YAML có lint, ảnh từng step, lưu = commit, phát hiện xung đột, lịch sử.

**Independent Test**: sửa `timeout_ms`, lưu → commit mới; YAML sai → khóa lưu; hai tab → tab sau báo xung đột (quickstart §5).

- [ ] T047 [P] [US5] Server: `GET /testcases/:id/snapshots`, `GET /testcases/:id/files/*path` (chỉ trong `snap/<slug>/`, chặn `..`, `Content-Type` theo đuôi), `GET /testcases/:id/last-run-steps`; test `testcase-files.int.test.ts` (đọc ảnh, path ngoài `snap/<slug>/` → 404, tenant khác → 404)
- [ ] T048 [US5] Web `components/YamlEditor.tsx`: CodeMirror 6 + YAML + lint từ `validateTestCaseSource` (dòng/cột, step, mã lỗi), debounce ≤ 1 s; trang `routes/projects.$projectId.testcases.$testCaseId.tsx`: cột ảnh từng step (snapshot → lần chạy gần nhất → "No image yet"), **Save** ✍ với `base_commit` (409 → thông báo "Changed by someone else", giữ nội dung), **History**; test component (lỗi hiện đúng dòng, save khóa, 409)
- [ ] T049 [US5] E2E `e2e/us5-editor.e2e.ts`: sửa và lưu → History có commit mới; YAML sai → Save khóa; hai tab → xung đột; chụp ảnh

**Checkpoint**: US5 xong.

---

## Phase 8: User Story 6 - Tìm element bằng ảnh (Priority: P2)

**Goal**: locator `image` chạy được lúc chạy lại, không khớp nhầm.

**Independent Test**: unit trên `fixtures/images/` (≥ 95 % đúng, 0 khớp nhầm); 🔌 step đổi id/chữ vẫn pass `degraded` bằng ảnh (quickstart §6).

- [ ] T050 [US6] Runner `core/image/matcher.ts` (interface `ImageMatcher.find(screenPng, templatePng, { threshold, scale }) → { bounds, score } | undefined`) + `core/image/opencv.ts` (nạp lười `@techstark/opencv-js`, thang xám, `matchTemplate TM_CCOEFF_NORMED`, co ảnh tham chiếu theo `screen_width`); test `matcher.test.ts` trên `fixtures/images/` — **SC-005**: tìm đúng nút đổi chữ/id, không khớp khi không có nút, ≤ 1 s
- [ ] T051 [US6] Runner `run-testcase.ts`: `resolveTarget()` bất đồng bộ — thử chuỗi theo thứ tự, gặp `image` thì chụp màn hình + matcher (asset qua `RunOptions.assets(path) → bytes`), khớp → element ảo (bounds vùng khớp), `locator_used_index`, `degraded`; kiểm "bị che" ở mức cửa sổ; test `run-testcase.image.test.ts` (FakeDriver `renderScreens`: id đổi → ảnh khớp, degraded; không khớp → `TARGET_NOT_FOUND`)
- [ ] T052 [US6] Giao ảnh cho agent: dispatcher đọc file ảnh mà test case tham chiếu tại commit của item, chép lên S3 `<tenant>/assets/<sha256>` (nếu chưa có), thêm `items[].assets` presigned GET; agent tải và cache theo sha256 (`<cacheDir>/assets/`), sai sha → item `error`; `coral run --project-root` (mặc định: cha của `testcases/` hoặc thư mục YAML) đọc ảnh từ đĩa; test `dispatcher-assets.int.test.ts`, `jobs.test.ts` ca assets, `run.test.ts` (CLI) ca image
- [ ] T053 [US6] 🔌 `android-driver.device.test.ts`: template matching trên ảnh chụp thật của My Demo App (cắt nút menu từ khung đầu, tìm lại sau khi mở/đóng menu) và `coral run` một test case có id sai + locator ảnh → `degraded`, `passed`

**Checkpoint**: US6 xong.

---

## Phase 9: User Story 7 - Chuẩn bị từ web: app, build và agent (Priority: P3)

**Goal**: người mới đi từ đầu tới ghi test chỉ bằng trình duyệt.

**Independent Test**: tạo app, tải APK, tạo token agent trên web → agent dùng token đó hiện thiết bị (quickstart §7).

- [ ] T054 [P] [US7] Web tab **Apps & builds**: tạo app ✍, tải APK ✍ (multipart, tiến độ, lỗi 413), danh sách build (phiên bản, kích thước); test component
- [ ] T055 [P] [US7] Web trang Devices: **Add agent** ✍ → token hiện **một lần**, nút Copy, cảnh báo; danh sách agent + Revoke ✍; test component
- [ ] T056 [US7] E2E `e2e/us7-setup.e2e.ts`: tạo app, tải APK giả, tạo agent token → khởi động agent giả với token đó → thiết bị hiện trên `/devices`; chụp ảnh

**Checkpoint**: US7 xong.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T057 [P] Đồng bộ tài liệu: SPEC §15 (payload `stream.*`, `device.command`, `job.assign.assets`), §16 (route control/recordings/snapshots, `WS /ws/ui` xác thực bằng `ui.auth`), §7.2 (dạng object của `image`), §21 Decision log cho quyết định mới (xác thực `/ws/ui` trong băng; recorder tap tâm element; bản ghi ở server); CLAUDE.md "Lệnh thường dùng" thêm `test:e2e`, `dev:fake-device`; README mục Web
- [ ] T058 [P] Kiểm tra SC-008 cho Recorder: `scripts/phase1-e2e.mjs --scan-secrets` mở rộng quét `recordings/*` và `snap/` của test case vừa lưu; test tích hợp quét sau E2E US4 → 0
- [ ] T059 Chạy đủ cổng chất lượng (format, lint, boundaries, typecheck, test, test:int, test:e2e, build) + quickstart §1; push; CI xanh cả các job (`checks`, `infra`, `integration`, `e2e`, `Device`)
- [ ] T060 Đóng Phase 2: tự kiểm từng mục DoD (quickstart checklist), đánh dấu `[x]` Phase 2 trong `docs/ROADMAP.md`, báo cáo Huynh kèm ảnh (ghi trình duyệt đã kiểm: Chromium tự động; Firefox/Edge kiểm tay — FR-024), chuyển "Phase hiện tại" → Phase 3

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001–T004)**: T002, T003 song song; T004 sau T001 (dùng build web).
- **Foundational (T005–T018)**: T005–T009, T011 song song; T010 cần T009 (locator ảnh hợp lệ); T012 cần T011 (render); T013 → T014 → T015; T016 độc lập; T017 cần T006; T018 cần T011, T015, T017.
- **US1 (T019–T026)**: cần Foundational.
- **US2 (T027–T031)**: cần T005, T007, T015, T016, T017.
- **US3 (T032–T035)**: cần US2 (live view để điều khiển), T013, T014.
- **US4 (T036–T046)**: cần US3; T036–T039 (runner thuần) song song và có thể làm ngay sau Foundational.
- **US5 (T047–T049)**: cần US1 (trang test case); ảnh snapshot đầy đủ khi có US4.
- **US6 (T050–T053)**: T050–T051 độc lập với web (làm song song US1–US3); T052 cần dispatcher Phase 1. Schema locator ảnh (T009) đã ở Foundational.
- **US7 (T054–T056)**: cần US1.
- **Polish (T057–T060)**: cuối.

### User Story Dependencies

- **US1 (P1)**: độc lập sau Foundational.
- **US2 (P1)**: độc lập sau Foundational.
- **US3 (P1)**: dùng LiveView của US2.
- **US4 (P1, DoD)**: dùng điều khiển của US3; recorder thuần trong runner làm trước được.
- **US5 (P2)**: dùng trang test case (US1); ảnh từ US4.
- **US6 (P2)**: độc lập (runner + dispatcher); schema ở Foundational (T009) vì Recorder (US4) sinh locator ảnh.
- **US7 (P3)**: dùng web nền (US1).

### Within Each User Story

- Test viết cùng commit với code; test phải fail trước khi code xong phần tương ứng.
- Shared/schema → runner thuần → agent → server → web → E2E → 🔌.

### Parallel Opportunities

- Setup: T002, T003.
- Foundational: T005–T009, T011; T016 song song với chuỗi DB/WS.
- US1: T021, T022, T023 (web) song song với T019 (server).
- US4: T036, T037, T038, T039 (runner thuần) song song; T043 song song với T044.
- US6: T050, T051 song song với US1–US3.

---

## Parallel Example: User Story 4

```bash
# Recorder thuần trong runner (fixture, không thiết bị):
Task: "pick.ts — element đích tại điểm chạm"
Task: "locators.ts — chuỗi locator §7.2, kiểm lại bằng resolver"
Task: "suggest.ts — đề xuất kỳ vọng trước/sau"
Task: "crop.ts — cắt element.png"
```

---

## Implementation Strategy

### MVP First

1. Setup + Foundational.
2. US1 (web xem run) → dừng, chụp ảnh, Huynh duyệt.
3. US2 + US3 (live view, điều khiển) → E2E + ảnh.
4. US4 (Recorder) → E2E mô phỏng → 🔌 DoD trên emulator CI.

### Incremental Delivery

1. Foundation → US1 → US2 → US3 → US4 (DoD) → US5 → US6 → US7 → Polish.
2. Mỗi user story là một nhóm commit demo được; dừng ở mỗi checkpoint báo cáo Huynh kèm ảnh (CLAUDE.md "Cách làm việc").

### Phân công theo môi trường

- **Container / CI**: mọi task — unit, tích hợp, E2E với thiết bị giả; 🔌 chạy trên emulator Android 14 của GitHub Actions (`device.yml`), không cần máy Huynh.
