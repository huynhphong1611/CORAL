# Research: Phase 1 — Runner tất định trên Android + server tối thiểu

**Feature**: `002-phase-1-android-runner` · **Date**: 2026-09-28

Technical Context không còn mục NEEDS CLARIFICATION. Dưới đây là các quyết định thiết kế, mỗi mục: Decision / Rationale / Alternatives considered.

## R1. Điều khiển Android bằng `u2.jar` (D27)

- **Decision**: Driver Android nói chuyện với server UiAutomator2 của dự án `openatx/uiautomator2` (bản Python 3.7.0, jar `u2.jar` 0.4.0) như sau:
  1. `adb push u2.jar /data/local/tmp/u2.jar` (bỏ qua nếu md5 trên máy đã khớp).
  2. Khởi chạy tiến trình dài hạn: `adb shell CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p <device_port>` (mặc định 9008); đọc stdout để phát hiện lỗi `already registered` (đã có client UiAutomation khác — Appium hoặc u2 khác).
  3. `adb forward tcp:<local_port> tcp:<device_port>` (cổng cục bộ cấp phát theo thiết bị); gọi HTTP `POST /jsonrpc/0` với `{ jsonrpc: "2.0", id, method, params: [...] }`.
  4. Sẵn sàng khi `deviceInfo` trả lời trong 30 s.
- **Các lời gọi dùng** (chi tiết: [contracts/android-u2.md](./contracts/android-u2.md)): `dumpWindowHierarchy(false, 50)`, `click(x, y)` / `click(x, y, ms)` (long press), `swipe(fx, fy, tx, ty, steps)`, `pressKey("back")`, `setText(selector, text)` / `clearTextField(selector)`, `deviceInfo()`.
- **Nhập text Unicode (tiếng Việt)**: tap vào element để focus, rồi `setText({ focused: true }, text)` — đi qua `ACTION_SET_TEXT` của accessibility nên đúng từng ký tự, không cần cài IME. Không dùng `adb shell input text` (không hỗ trợ Unicode).
- **Screenshot**: `adb exec-out screencap -p` (PNG, độ phân giải thật). `takeScreenshot` của u2 trả JPEG có nén — không dùng cho artifact.
- **Kích thước cửa sổ**: `displayWidth` / `displayHeight` / `displayRotation` từ `deviceInfo()`.
- **Rationale**: nhanh (không có chặng Appium server, không tạo session), không cài APK test; JSON-RPC đơn giản để viết client TypeScript (giữ D07).
- **Alternatives**: Appium UiAutomator2 driver (chậm, nặng — bị bác bởi D27); gọi thẳng APK `appium-uiautomator2-server` (phải cài 2 APK + instrumentation); thư viện Python `uiautomator2` (agent phải có Python).

## R2. Lấy `u2.jar` và giấy phép

- **Decision**: Agent tải wheel `uiautomator2==3.7.0` từ PyPI khi cần, kiểm sha256 của wheel (`731bf4e2…e985`) và của `assets/u2.jar` (`0b74e83c…0eb6`, 3 707 333 byte), giải nén bằng `fflate`, cache tại `~/.cache/coral/u2/0.4.0/u2.jar`. Biến `CORAL_U2_JAR` cho phép chỉ đường tới jar có sẵn (máy không có mạng).
- **Rationale**: không chứa binary bên thứ ba trong repo; phiên bản ghim bằng checksum (R11 trong SPEC).
- **License**: gói Python là MIT; jar có kèm `LICENSE-junit.txt` (EPL). Phase 1 chỉ tải về lúc chạy, không phân phối lại. **Cần rà license đầy đủ trước khi thương mại hóa** (ghi thêm vào SPEC §20 Q3).
- **Alternatives**: vendor jar vào repo; build jar từ source (thêm toolchain Android vào CI).

## R3. Chuyển cây UiAutomator thành `ElementNode`

- **Decision**: parse XML của `dumpWindowHierarchy` bằng `fast-xml-parser`, map: `resource-id → platform_id`, `text`, `content-desc → desc`, `class`, `bounds "[x1,y1][x2,y2]" → {x,y,w,h}`, `clickable`, `enabled`, `visible-to-user → visible` (nếu thiếu thì coi là `true` khi bounds có diện tích > 0), `package → package_or_bundle`; `ref` = đường dẫn chỉ số (`0.3.1`) ổn định trong một lần dump. Giữ thêm `password`, `focused`, `scrollable`, `drawing_order` (nếu có) trong trường mở rộng `android`.
- **Rationale**: thư viện nhỏ, nhanh, không phụ thuộc native; cây dump của u2 có đủ nhiều cửa sổ (app + dialog hệ thống) để popup guard thấy package khác.
- **Alternatives**: `xmldom` (chậm, API DOM cồng kềnh), tự viết parser.

## R4. Resolver locator (§7.2)

- **Decision**: hàm thuần `resolve(target, tree, ctx)` trong `runner/core/locator`:
  - Bỏ qua locator của nền tảng khác; `firstApplicableIndex` tính sau khi bỏ.
  - Chỉ xét node `visible` và giao với cửa sổ (`bounds` ∩ màn hình > 0).
  - `android_id` khớp đúng `platform_id` (chấp nhận viết tắt `id/foo` → `<package>:id/foo`); `text` khớp đúng sau chuẩn hóa khoảng trắng, phân biệt hoa/thường; `text_contains` chứa; `desc` khớp đúng.
  - `class` khớp tên đầy đủ hoặc tên ngắn (đoạn sau dấu `.` cuối) — D14.
  - `rel`: tìm anchor bằng locator lồng; ứng viên là node (lọc theo `class` nếu có) nằm hoàn toàn ở phía yêu cầu và **chồng lấn trục còn lại**; chọn ứng viên gần anchor nhất.
  - `class_index`: lọc theo `class` (trong subtree của `within` nếu có), sắp theo thứ tự duyệt cây, lấy `index` (bắt đầu từ 0).
  - Nhiều node khớp → ưu tiên node `clickable`, rồi node sâu nhất, rồi thứ tự duyệt — quy tắc được test bằng fixture.
  - `point_pct` luôn "khớp" (trả về điểm, không có node).
- **Rationale**: thuần → test không cần thiết bị (SC-004); cùng code chạy cho iOS/web sau này (D28).

## R5. Chờ ổn định, hit-test và kỳ vọng

- **Decision**:
  - `waitForStable`: dump cây, băm cấu trúc `(class, platform_id, bounds làm tròn 4 px)` **bỏ qua text** (đồng hồ, bộ đếm không làm mất ổn định); hai lần liên tiếp cách 300 ms giống nhau là ổn định; tối đa 3000 ms rồi làm tiếp và gắn `unstable = true` cho step.
  - Hit-test (§8.4): trong cây vừa dump, lấy các node chứa điểm tap; node trên cùng = thuộc cửa sổ sau cùng, rồi `drawing_order` lớn nhất, rồi sâu nhất. Hợp lệ nếu node đó là target hoặc nằm trong subtree của target. Không hợp lệ → gọi popup guard; vẫn bị che → `TARGET_NOT_FOUND` với lý do "covered".
  - `checkExpect`: thăm dò mỗi 250 ms đến `timeout_ms` (mặc định 5000); mọi điều kiện trong danh sách phải đúng cùng lúc.
  - `expect.screen` và locator `image`: schema chấp nhận nhưng `coral validate` báo "chưa hỗ trợ ở Phase 1" (lỗi), để không có test case chạy sai âm thầm.
- **Alternatives**: `sleep` cố định (trái §8.3); băm cả text (không bao giờ ổn định với đồng hồ).

## R6. Popup guard, crash và ANR

- **Decision**:
  - Nhận diện popup: có node thuộc package khác app đang test và không phải `com.android.systemui` (thanh trạng thái), **hoặc** node dialog (`android:id/parentPanel`, `buttonPanel`) che vùng app.
  - Gói hộp thoại quyền: `com.android.permissioncontroller`, `com.google.android.permissioncontroller`, `com.android.packageinstaller` (Android cũ).
  - Hộp thoại crash/ANR (package `android`, id `android:id/aerr_close`, `aerr_wait`, `aerr_restart`) **không** phải popup: runner dừng với `APP_CRASHED` / `APP_NOT_RESPONDING`. Kiểm tra thêm `pidof <package>` và `logcat -b crash` từ lúc bắt đầu step.
  - So khớp luật và `never_tap` là hàm thuần trong `packages/shared/popups` (dùng lại ở Explorer Phase 3).
  - Ngoại lệ "đang test chính popup": nếu locator đầu tiên áp dụng được của target/expect khớp một node trong popup → không đóng.
  - Tối đa 3 popup mỗi step (D25); mỗi lần xử lý ghi `{ rule, button }` vào kết quả step.
- **Alternatives**: chỉ dựa vào package permissioncontroller (bỏ sót dialog trong app như "đánh giá app").

## R7. Chuẩn bị thiết bị (§8.3, §9.1)

- **Decision**, theo thứ tự trước mỗi test case:
  1. Cài build nếu checksum đã cài khác (agent nhớ `sha256` build đã cài theo thiết bị): `adb install -r -d <apk>`.
  2. `app_state: fresh` → `pm clear <package>`.
  3. `pm grant <package> <permission>` cho từng quyền trong `grant_permissions` (ánh xạ §7.5; `notifications` chỉ khi API ≥ 33).
  4. Đặt `window_animation_scale`, `transition_animation_scale`, `animator_duration_scale` = 0; ghi giá trị cũ; khôi phục khi dọn dẹp nếu là **máy thật** (P6).
  5. `launch`: `monkey -p <package> -c android.intent.category.LAUNCHER 1`; `open_deeplink`: `am start -W -a android.intent.action.VIEW -d <url>`.
- **Rationale**: chỉ đụng tới package đang test và cài đặt animation (P6).
- **Alternatives**: `adb install -g` (cấp mọi quyền — làm mất khả năng test popup quyền, trái DoD).

## R8. Kho git project (D15, D31)

- **Decision**: mỗi project một repo git **có working tree** do server độc quyền quản lý tại `${CORAL_DATA_DIR}/repos/<tenant_id>/<project_id>/`, sau interface `ProjectRepoStore`; ghi tuần tự bằng mutex theo project; mỗi lần lưu test case / `popups.yaml` là một commit (author = user, message `testcase: <slug>` / `popups: update`). Đọc nội dung theo commit bằng `git show <commit>:<path>`. Server kiểm tra hợp lệ (Zod + validate) **trước** khi commit.
- **Rationale**: đơn giản với một instance (R10); lịch sử có sẵn cho Healer (Phase 4) và editor (Phase 2).
- **Alternatives**: bare repo + plumbing (phức tạp hơn khi chưa cần); Gitea (thêm dịch vụ).

## R9. Hàng đợi, lease, timeout (D16)

- **Decision**:
  - Bảng `leases` có partial unique index `(device_id) WHERE released_at IS NULL` → không thể có hai lease mở trên một thiết bị, kể cả khi có lỗi đồng thời (SC-007).
  - BullMQ queue `run-dispatch`: job thử lấy lease trong transaction; thiết bị bận/offline → hẹn lại sau 2 s (backoff tối đa 10 s) cho tới **queue timeout** 10 phút → run `error` / `TIMEOUT`.
  - Lấy được lease → gửi `job.assign`; chờ `job.ack` 30 s, không có → giải phóng lease, thử lại một lần.
  - Queue `run-timeout`: job hẹn giờ ở mốc run timeout (30 phút) → gửi `job.cancel`, đánh dấu `TIMEOUT`.
  - Lease có `expires_at` = now + 60 s, gia hạn mỗi heartbeat (15 s); mất 3 heartbeat → agent `offline`, thiết bị `offline`, item đang chạy `DEVICE_OFFLINE`, lease giải phóng (SC-009).
- **Alternatives**: chỉ dùng DB polling (tự viết hẹn giờ); chỉ BullMQ (không có ràng buộc toàn vẹn).

## R10. Giao thức agent ↔ server

- **Decision**: server dùng `@fastify/websocket` tại `WS /ws/agent`; agent dùng `ws` (hỗ trợ header `Authorization` khi upgrade). Mọi message validate bằng Zod (`packages/shared/protocol`), envelope `{ v, type, id, ts, re?, payload }` (D18). Agent tự kết nối lại với backoff 1 s → 30 s. Hai message **bổ sung** so với bảng §15 (đã ghi vào SPEC — D33): `agent.heartbeat` (A→S, mỗi 15 s) và `item.result` (A→S, kết quả từng test case để server cập nhật dần). Chi tiết: [contracts/ws-protocol.md](./contracts/ws-protocol.md).
- **Alternatives**: WebSocket có sẵn của Node (không đặt được header chuẩn); WS ping/pong thuần (không mang được trạng thái thiết bị).

## R11. Artifact và build trên S3/MinIO

- **Decision**:
  - Key: `<tenant_id>/builds/<build_id>.apk`; `<tenant_id>/runs/<run_id>/<run_item_id>/<step_index>-<step_id>/{screenshot.png,tree.json,device.log}`.
  - Agent xin presigned PUT theo lô cho mỗi step (`artifact.request_upload`), hạn 10 phút; API trả presigned GET hạn 15 phút.
  - Server tạo bucket và lifecycle rule 30 ngày cho prefix `*/runs/` khi khởi động (MinIO hỗ trợ lifecycle S3).
  - Upload build: `@fastify/multipart` stream thẳng lên S3, tính sha256 trên đường truyền; agent tải bằng presigned GET, cache theo sha256.
- **Alternatives**: gửi artifact qua WS (nặng, chặn kênh điều khiển).

## R12. Xác thực tối thiểu

- **Decision**: user seed tạo bằng `pnpm --filter @coral/server db:seed` từ `CORAL_SEED_EMAIL` / `CORAL_SEED_PASSWORD`; mật khẩu argon2id (`@node-rs/argon2`). Access token JWT HS256 (`jose`, khóa `CORAL_JWT_SECRET`, hạn 15 phút, claim `sub`, `tid`, `role`); refresh token ngẫu nhiên, lưu băm, xoay vòng, cookie `httpOnly; Secure; SameSite=Strict; Path=/auth` (D23) — trả thêm trong body khi header `X-Coral-Client: cli` để script dùng được. Agent token dạng `coral_agt_<32 byte base64url>`, lưu SHA-256 (token entropy cao nên không cần argon2), chỉ hiện một lần.
- **Alternatives**: session trong Redis (thêm trạng thái); OAuth (thừa cho một user seed).

## R13. Secret trước Phase 5 (D19)

- **Decision**: khi tạo run, server quét `${secret:NAME}` trong các test case (theo commit sẽ chạy) và đọc `CORAL_SECRET_<NAME>` từ môi trường server; thiếu → `422` liệt kê tên. Giá trị gửi trong `job.assign.secrets` (qua WSS ở môi trường thật). Agent và `coral run` thay giá trị lúc chạy, và `redact()` mọi chuỗi trùng giá trị secret (≥ 4 ký tự) trong log, `step.result`, `tree.json`, `device.log`. Screenshot không che được — ô mật khẩu Android tự hiển thị `•`.
- **Alternatives**: gửi secret từ agent (agent không nên giữ secret dài hạn).

## R14. Chiến lược test

- **Decision**:
  - **Unit (CI)**: schema/validate với bộ file hợp lệ/lỗi (`fixtures/testcases`, SC-006); resolver với cây giả từ `fixtures/android` (SC-004); parser XML; popup guard và vòng lặp runner chạy trên `FakeDriver` (kịch bản màn hình, có popup, crash); redact.
  - **Tích hợp `*.int.test.ts` (CI job riêng dựng `docker compose`)**: API + DB + git store + S3; dispatcher + lease (10 run đồng thời một thiết bị, SC-007); agent giả kết nối WS với `FakeDriver` chạy trọn một run (SC-002); agent mất kết nối (SC-009, rút ngắn heartbeat bằng cấu hình test).
  - **Thiết bị `*.device.test.ts`** (chạy tay): driver Android trên emulator; toàn bộ DoD bằng `scripts/phase1-e2e.mjs` (5/5 run, SC-001, SC-003, SC-005, SC-008).
- **Rationale**: phần lớn logic kiểm được trong CI; chỉ phần đụng thiết bị thật cần emulator (container CI không có KVM).
- Quy ước `*.int.test.ts` (chạy khi `CORAL_INT_TESTS=1`, `pnpm test:int`) đã ghi vào SPEC §19 và `CLAUDE.md` (D34); `vitest.shared.ts` cập nhật trong task Setup.

## R15. App mẫu tham chiếu

- **Decision**: Sauce Labs My Demo App (Android) — màn đăng nhập với tài khoản demo công khai; màn quét QR cần quyền camera cho kịch bản popup quyền (SC-003). Tên tài khoản/mật khẩu demo đưa vào `CORAL_SECRET_TEST_USER` / `CORAL_SECRET_TEST_PASSWORD`.
- **Cần xác minh khi làm device test**: bản APK mới nhất, resource-id thực tế, và màn QR có xin quyền runtime trên Android 14. Nếu không, dùng app fixture tối giản (sẽ cần ở Phase 4) cho riêng kịch bản quyền.
