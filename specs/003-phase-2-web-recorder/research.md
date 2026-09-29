# Research: Phase 2 — Web UI, live view, recorder

**Feature**: `003-phase-2-web-recorder` · **Date**: 2026-09-29 · Nguồn: spec.md, SPEC §5.1, §7.2, §11.1, §13, §15–§16, §19, D16, D18, D23, D27, D36

Mỗi mục: **Decision** / **Rationale** / **Alternatives**. Các điểm đã kiểm trên emulator Android 14 trong CI (Phase 1) được ghi rõ.

## R1. Web stack

- **Decision**: React 19 + Vite 8 + TanStack Query (đã có) + **TanStack Router** (file-less, route cây khai báo trong code, type-safe params) + **Tailwind CSS 4** (`@tailwindcss/vite`) — đúng SPEC §19. Editor YAML: **CodeMirror 6** (`@codemirror/lang-yaml`, `@codemirror/lint`). Lỗi YAML trong editor lấy từ `validateTestCaseSource` của `@coral/shared` chạy ngay trong trình duyệt (cùng mã với `coral validate`, FR-018). Chuỗi giao diện tiếng Anh (clarify Q1), gom trong `apps/web/src/i18n/en.ts` để thêm ngôn ngữ sau.
- **Rationale**: stack đã chốt; CodeMirror 6 nhẹ (~150 KB gzip) so với Monaco (~2 MB) và có API lint gắn được vị trí dòng/cột mà `parseYaml` của shared đã trả.
- **Alternatives**: React Router 7 (kém type-safe với search params); Monaco (nặng, worker phức tạp với Vite); tự viết textarea (không có lint theo dòng).

## R2. Đăng nhập và gọi API từ trình duyệt

- **Decision**: giữ D23: access token trong bộ nhớ (React context), refresh token trong cookie `httpOnly` path `/auth`. SPA gọi `/api/*`; Vite dev proxy bỏ tiền tố `/api` và **đổi path cookie** (`cookiePathRewrite: { '/auth': '/api/auth' }`) để trình duyệt gửi cookie khi gọi `/api/auth/refresh`. Khi tải trang: gọi refresh một lần để khôi phục phiên (US1 kịch bản 1). Client tự refresh khi gặp 401 rồi thử lại đúng một lần; refresh thất bại → về trang đăng nhập, giữ bản ghi dở (FR-016). Triển khai thật: reverse proxy cùng quy tắc (ghi trong quickstart), server không phục vụ file tĩnh (SPEC §19 "server tách riêng").
- **Rationale**: không đổi API Phase 1 (script, agent, test đang dùng path gốc); cookie path là chỗ duy nhất vỡ khi thêm tiền tố.
- **Alternatives**: chuyển mọi route server sang `/api` (vỡ `phase1-e2e.mjs`, agent, test); lưu refresh token ở `localStorage` (trái D23, lộ trước XSS).

## R3. Kênh thời gian thực trình duyệt ↔ server: `WS /ws/ui`

- **Decision**: một WebSocket mỗi tab tới `WS /ws/ui` (SPEC §16). Trình duyệt không đặt được header `Authorization` cho WebSocket → message đầu tiên phải là `ui.auth { access_token }` trong ≤ 5 s, sai/hết hạn → đóng `4401`; token hết hạn giữa chừng → client gửi `ui.auth` mới (không cần nối lại). Cùng envelope `{ v, type, id, ts, re?, payload }` với giao thức agent (D18), Zod ở `packages/shared/src/protocol/ui.ts`. Khung hình live view đi bằng **binary frame** (R5).
- Nội dung: sự kiện run (`run.updated`, `step.recorded`… — thay polling ở trang run), `device.updated`, đăng ký xem màn hình (`stream.subscribe/unsubscribe`), lệnh điều khiển (`live.command` → `live.result`), bước ghi (`recording.step`).
- **Rationale**: không để token trong URL (log proxy, lịch sử); một kênh cho mọi thứ thời gian thực.
- **Alternatives**: vé một lần qua query string (`?ticket=`) — thêm một endpoint và vẫn lộ trong log; SSE cho sự kiện + WS riêng cho hình (hai kết nối, SSE không gửi được lệnh).

## R4. Chụp màn hình cho live view

- **Decision**: agent gọi JSON-RPC `takeScreenshot(scale, quality)` của u2 (trả JPEG base64, máy tự nén) với `scale` sao cho cạnh dài ≤ 1280 px và `quality` 60; fallback khi phương thức không có: `adb exec-out screencap -p` (PNG, gửi nguyên). Kiểm bằng device test trong CI (T có 🔌 → emulator CI).
- Nhịp: vòng lặp một khung một lúc — chụp → gửi → chờ `max(0, 1000/fps − thời gian đã tốn)`; mặc định 4 fps, tối thiểu 2 (SC-002). Không bao giờ xếp hàng khung cũ: nếu server/viewer chậm, khung mới thay khung chưa gửi.
- **Rationale**: JPEG từ máy nhỏ ~40–80 KB (540×1200) so với PNG 1–2 MB; không cần thư viện nén ảnh trong Node.
- **Alternatives**: `screencap` + nén JPEG bằng JS (`jpeg-js` — tốn CPU agent ~100 ms/khung); scrcpy/H.264 (tốt hơn nhưng để sau — SPEC §19).

## R5. Truyền khung hình: agent → server → trình duyệt

- **Decision**: binary WS frame `[uint32 BE độ dài header][header JSON UTF-8][bytes ảnh]`, header `{ type: "stream.frame", udid | device_id, seq, ts, width, height, device_width, device_height, rotation, mime }` (D18). Server (`StreamHub`) theo dõi người xem theo thiết bị: người xem đầu tiên → `stream.start { udid, fps, max_edge, quality }` tới agent; người cuối rời (hoặc agent mất) → `stream.stop`. Server chuyển tiếp khung cho từng người xem, **bỏ khung** cho kết nối có `bufferedAmount` > 1 MB (người xem chậm không làm chậm người khác). Kiểm tenant: chỉ người xem cùng tenant với thiết bị (FR-002).
- Trình duyệt vẽ lên `<canvas>` bằng `createImageBitmap(blob)`; khung cũ hơn khung đang vẽ bị bỏ. Không có khung > 5 s → hiện "mất kết nối" (US2 kịch bản 3).
- **Rationale**: đúng D18; không base64 (+33 %); fan-out ở server để agent chỉ gửi một luồng dù có nhiều người xem.
- **Alternatives**: MJPEG qua HTTP (thêm route, khó kiểm tenant theo WS); agent gửi thẳng cho trình duyệt (agent sau NAT).

## R6. Phiên thiết bị trên agent

- **Decision**: thêm `DeviceSessions` trong agent: mỗi thiết bị tối đa một `UiDriver` đang mở (u2 server), dùng chung cho job, live stream và lệnh điều khiển; mở khi cần, đóng sau 60 s không dùng. `TargetLifecycle` (adb, theo app) tạo riêng khi có app. `JobManager` chuyển sang lấy driver từ `DeviceSessions` thay vì tự tạo/đóng. Live stream chạy song song với job (xem run đang chạy — US2) vì chỉ đọc màn hình; lệnh điều khiển thì server chỉ gửi khi phiên điều khiển đang giữ lease (R7).
- **Rationale**: u2 chỉ nên có một instance mỗi thiết bị (Phase 1: server thứ hai làm UiAutomation của server đầu bị ngắt); mở/đóng u2 mỗi lần tốn 3–5 s.
- **Alternatives**: driver riêng cho stream (hai u2 xung đột); stream bằng adb không qua u2 (PNG nặng, R4).

## R7. Phiên điều khiển và lease `live`

- **Decision**: `POST /devices/:id/control` → lấy lease `kind = live`, `holder_ref = live:<session_id>` (partial unique index Phase 1 đảm bảo một lease mở/thiết bị → không chạy song song với run, SC-006), trả `{ session_id, expires_at }`; mỗi lệnh gia hạn `expires_at = now + idle_timeout` (mặc định 10 phút, `CORAL_LIVE_IDLE_MS`); lease sweeper Phase 1 thả lease quá hạn; `DELETE /devices/:id/control` thả ngay; agent mất kết nối → thả (`agent_offline`). Run đang chờ thiết bị: dispatcher Phase 1 đã `retryLater` khi không lấy được lease → tự chạy sau khi thả. Lệnh `live.command` qua `/ws/ui` chỉ chấp nhận từ đúng người giữ phiên, vai trò ≠ viewer (FR-002a); danh sách lệnh đóng (FR-008): `tap`, `long_press`, `swipe`, `type`, `back`, `home`, `hide_keyboard`, `restart_app`; mỗi lệnh ghi bảng `device_commands` (FR-009, không lưu chữ đã gõ — chỉ độ dài).
- Server → agent: `device.command { command_id, udid, command }` → agent trả `device.command_result { command_id, ok, error?, ... }` (`re` bắt buộc — SPEC §15).
- **Rationale**: dùng lại lease/sweeper/dispatcher của Phase 1; D16 đã định `live`.
- **Alternatives**: khóa trong bộ nhớ server (mất khi restart, không chặn được dispatcher).

## R8. Recorder: chọn element và trích locator (không AI — SPEC §11.1, P2)

- **Decision**: logic thuần trong `packages/runner/src/core/recorder/` (agent chạy, web không import runner — D08), dùng lại resolver và hit-test Phase 1:
  1. Cây đọc **sau khi màn hình ổn định** (`waitForStable`); element đích = `touchTargetAt(tree, point)` (D36) nếu nó bấm được, nếu không thì element bấm được nhỏ nhất chứa điểm (FR-011).
  2. Ứng viên theo thứ tự §7.2: `android_id` (nếu có id), `text` (nếu có chữ), `desc`, `rel` (so với nhãn có chữ gần nhất phía trên/trái, kèm `class` ngắn), `class_index` (trong tổ tiên gần nhất có id), `image`, `point_pct`.
  3. Mỗi ứng viên (trừ `image`, `point_pct`) chỉ được giữ nếu `resolve([candidate], tree)` trả **đúng** element đích — nên locator đầu tiên luôn đúng lúc ghi (SC-004).
  4. `image` luôn thêm cho step chạm (FR-012); `point_pct` chỉ thêm (ở cuối) khi không ứng viên có cấu trúc nào đạt bước 3.
  5. Tap thực hiện tại **tâm bounds của element đích** (giống lúc chạy lại), không phải điểm click, để ghi và chạy lại cùng một hành vi.
- Ô mật khẩu (`android.password = true`): step `type` bắt buộc chọn secret; agent nhận **giá trị** secret từ server (env `CORAL_SECRET_*`, D19) — giá trị không bao giờ đi qua trình duyệt (FR-014, SC-008). Chữ gõ ở ô thường trùng giá trị một secret → server đề xuất thay bằng tham chiếu (chỉ gửi tên secret cho trình duyệt).
- Chạm vào popup mà luật popup của project khớp (`findPopups` + `decidePopup`) → thực hiện nhưng không thành step, trả `popup_rule` để UI hiển thị (FR-015); nút thuộc `never_tap` → thành step kèm `warning: never_tap`.
- **Rationale**: tách logic thuần để unit test trên fixture (như Phase 1); đảm bảo chuỗi locator luôn tái tạo được.
- **Alternatives**: trích locator trên server (server phải có cây + ảnh; vẫn phải gọi resolver của runner → server phụ thuộc runner — không cần thiết); trong trình duyệt (web import runner — trái §5).

## R9. Đề xuất kỳ vọng sau mỗi thao tác (FR-013a)

- **Decision**: hàm thuần `suggestExpects(before, after)` trong `core/recorder/`: (1) chữ hiển thị mới xuất hiện trong cửa sổ app (so tập chữ trước/sau, bỏ chữ ≤ 2 ký tự, chữ số thuần, đồng hồ trên status bar) → `visible_text`, ưu tiên chữ có kích thước lớn / gần đỉnh màn hình; (2) element có id mới xuất hiện → `visible: [android_id]`; (3) element có id biến mất → `not_visible`. Tối đa 3, mỗi đề xuất kiểm lại bằng `checkExpect` trên cây sau (luôn đúng lúc ghi). Không có gì mới → không đề xuất; step chạm không có `expect` được gắn cảnh báo `no_expect_after_tap` (cùng mã với `coral validate`).
- **Rationale**: tất định, không AI (P1), dễ test bằng fixture trước/sau.
- **Alternatives**: gọi AI mô tả màn hình (Phase 3 mới có Brain); bắt buộc kỳ vọng (Huynh chọn đề xuất — clarify Q4).

## R10. Bản ghi (recording) lưu ở đâu

- **Decision**: server giữ bản ghi dở trong bảng `recordings` (steps jsonb) — không mất khi tải lại trang hoặc đổi máy (FR-016). Mỗi step ghi kèm snapshot tải lên S3 dưới `<tenant_id>/recordings/<recording_id>/<n>/{screen.jpg, tree.json, element.png}` bằng presigned URL do server sinh (như artifact Phase 1, T062). Bản ghi tự hết hạn sau 7 ngày không dùng (job dọn, xóa cả object S3). Người dùng sửa, xóa, sắp xếp step bằng API; YAML sinh ra từ steps + `intent`/tên người dùng nhập, có thể sửa tay trước khi lưu.
- **Rationale**: bản ghi sống lâu hơn một phiên trình duyệt; snapshot cần có trước khi lưu để editor xem trước.
- **Alternatives**: chỉ `localStorage` (mất khi đổi máy, snapshot không có chỗ lưu).

## R11. Lưu test case từ Recorder và snapshot trong kho git (§13)

- **Decision**: `POST /recordings/:id/save { slug, intent, yaml }` → `validateTestCaseSource` (như Phase 1) → trong **một commit** (FR-017): `testcases/<slug>.yaml` + `snap/<slug>/<step_id>/screen.jpg`, `tree.json`, `element.png` (chép từ S3). Locator ảnh trong YAML trỏ `image: snap/<slug>/<step_id>/element.png` (đường dẫn tính từ gốc repo). `ProjectRepoStore.commitFiles` mở rộng nhận nội dung nhị phân (Buffer). `test_cases.source = recorder`. Editor lưu (`PUT /testcases/:id`) không đụng `snap/`.
- `validateTestCase` thêm kiểm tra: file ảnh mà locator `image` tham chiếu phải có trong repo (server) / trên đĩa (`coral validate`, `coral run`) — FR-022; gỡ lỗi "image chưa hỗ trợ" của Phase 1.
- **Rationale**: tri thức là file thuần trong repo (P4); commit nguyên tử để lịch sử khớp; rủi ro repo phình to đã chấp nhận (R9 SPEC).
- **Alternatives**: ảnh ở S3, YAML chứa URL (mất khi hết hạn lifecycle, trái P4).

## R12. Locator `image` lúc chạy (FR-021, D27)

- **Decision**: `@techstark/opencv-js` trong `packages/runner` (nạp lười — chỉ khi một step thực sự cần thử locator ảnh; ~9 MB, 1–2 s khởi động). Chuỗi locator được thử theo thứ tự như Phase 1; gặp `image` thì runner chụp ảnh màn hình PNG (`screenshot()`), giải mã bằng `fast-png`, `matchTemplate(TM_CCOEFF_NORMED)` ở thang xám, nhận nếu điểm ≥ `threshold` (mặc định 0,85). Ảnh tham chiếu cắt ở độ phân giải thiết bị lúc ghi; Recorder ghi thêm `screen_width` của thiết bị lúc ghi, runner co ảnh tham chiếu theo tỉ lệ `bề rộng hiện tại / screen_width` một lần (không dò nhiều tỉ lệ — thiết bị khác mật độ nhiều có thể trượt, chấp nhận ở Phase 2). Khớp → "element ảo" có bounds vùng khớp; tap vào tâm; kiểm tra "bị che" chỉ ở mức cửa sổ (cửa sổ trên cùng tại điểm phải là của app). `resolve()` đồng bộ giữ nguyên (bỏ qua `image`); thêm `resolveTarget()` bất đồng bộ trong `run-testcase` gọi matcher khi cần. Schema locator: `image: string | { path, threshold?, screen_width? }` (chuỗi = đường dẫn, giữ tương thích `coral/testcase@1` — D28 chỉ mở rộng).
- Agent nhận ảnh qua `job.assign.items[].assets: [{ path, sha256, download_url }]` — server chép file tham chiếu từ repo lên S3 theo nội dung (`<tenant_id>/assets/<sha256>`) khi giao job; agent cache theo sha256 (như build). `coral run` đọc ảnh từ gốc project (`--project-root`, mặc định thư mục cha của `testcases/`, hoặc thư mục của file YAML).
- **Rationale**: SPEC §19/D27 đã chọn; nạp lười để run không có locator ảnh không trả giá.
- **Alternatives**: `sharp` + so khớp tự viết (native dep, chậm hơn OpenCV); so khớp trên thiết bị (u2 không có).

## R13. Vai trò (clarify Q2)

- **Decision**: guard `requireRole('owner','admin','member')` cho: `POST /runs`, `POST /runs/:id/cancel`, `POST|PUT` test case / popups, `POST /devices/:id/control`, mọi route `recordings`, `live.command` trên WS; `viewer` nhận 403 `forbidden` (FR-002a). Xem (GET, `stream.subscribe`) mở cho mọi vai trò trong tenant.
- **Rationale**: vai trò đã có trong JWT (`role`) từ Phase 1.

## R14. Kiểm thử

- **Decision**:
  - Unit (CI): recorder (chọn element, chuỗi locator, đề xuất kỳ vọng) trên `fixtures/android/*`; framing binary; `StreamHub`; image matcher với ảnh fixture (`fixtures/images/`: màn hình + nút đã đổi chữ/id); component web (Vitest + Testing Library, jsdom).
  - Tích hợp (`*.int.test.ts`): phiên điều khiển + lease (run chờ, idle timeout), `/ws/ui` auth + tenant, stream qua agent giả, recording → save → commit có snapshot.
  - E2E web (Playwright, Chromium có sẵn trong CI và container): server + agent thật + `FakeDriver` biết **vẽ** màn hình ra PNG từ cây element (`renderTree`) → ghi 5 step trên web, lưu, chạy lại 3/3 (SC-001 mô phỏng) và chụp ảnh giao diện.
  - 🔌 Emulator CI (`device.yml`): cùng kịch bản Playwright trên My Demo App thật (DoD SC-001), `takeScreenshot` của u2, template matching trên ảnh thật.
- **Rationale**: Phase 1 cho thấy emulator CI bắt được lỗi mà FakeDriver bỏ sót (D36) — DoD phải chạy trên emulator.

## R15. Phục vụ web trong CI/E2E

- **Decision**: E2E chạy `vite preview` (bản build) với cùng cấu hình proxy như dev; server và agent chạy bằng `tsx` như `pnpm dev`. Playwright dùng Chromium có sẵn (`/opt/pw-browsers` trong container, `npx playwright install chromium` trong CI).
- **Alternatives**: server phục vụ file tĩnh (trái §19 "server tách riêng").
