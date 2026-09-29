---

description: "Task list for Phase 1 — deterministic Android runner + minimal server"
---

# Tasks: Phase 1 — Runner tất định trên Android + server tối thiểu

**Input**: Design documents from `specs/002-phase-1-android-runner/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: CÓ — CLAUDE.md yêu cầu mỗi task kèm test. Ba loại (D21, D34):
- `*.test.ts` — unit, chạy trong CI mặc định.
- `*.int.test.ts` — cần Postgres/Redis/MinIO, chạy bằng `pnpm test:int` (job CI riêng).
- `*.device.test.ts` — cần emulator/thiết bị thật, **chạy trên máy Huynh** (`pnpm test:device`); task có 🔌.

**Organization**: theo user story US1–US5 của spec.md. Mỗi task là một commit nhỏ (code + test).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: chạy song song được (khác file, không phụ thuộc task chưa xong)
- **[Story]**: US1–US5 theo spec.md
- 🔌: cần thiết bị thật — làm trên máy Huynh

## Path Conventions

Monorepo (plan.md → Project Structure): `packages/shared/src/`, `packages/runner/src/` (mới), `packages/cli/src/`, `apps/server/src/`, `apps/agent/src/`, `fixtures/`, `scripts/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: gói mới, quy ước test, cấu hình, fixture

- [x] T001 Tạo gói `packages/runner` (`package.json` tên `@coral/runner`, deps `@coral/shared`, `fast-xml-parser`, `fflate`; `tsconfig.json` types node; `vitest.config.ts`; `src/index.ts`), thêm `@coral/runner` vào deps của `packages/cli` và `apps/agent`; test: `pnpm check:boundaries` xanh và `scripts/boundaries.test.ts` thêm ca "runner không được phụ thuộc @coral/brain"
- [x] T002 Luật ESLint D28 trong `eslint.config.js`: file `packages/runner/src/core/**` không được import `**/drivers/**`, `node:child_process`, `node:net`; test `scripts/eslint-boundaries.test.ts` dùng `ESLint#lintText` với một file giả trong `core/` import driver → báo lỗi
- [x] T003 Quy ước test tích hợp (D34): `vitest.shared.ts` export `testSelection(env)` — mặc định loại `*.int.test.ts` và `*.device.test.ts`; `CORAL_INT_TESTS=1` chỉ chạy `*.int.test.ts`; root script `test:int`; job CI `integration` trong `.github/workflows/ci.yml` (compose up --wait → `pnpm test:int`, chấp nhận chưa có test; bước migrate thêm ở T014); test `scripts/test-selection.test.ts` cho 3 chế độ
- [x] T004 [P] Mở rộng config server `apps/server/src/config.ts`: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `CORAL_DATA_DIR`, `CORAL_JWT_SECRET` (≥ 32 ký tự), `CORAL_SEED_EMAIL/PASSWORD`, thời hạn (heartbeat 15000, queue timeout 600000, run timeout 1800000 ms); cập nhật `.env.example`; test `config.test.ts` (mặc định, thiếu JWT secret → lỗi)
- [x] T005 [P] Mở rộng config agent `apps/agent/src/config.ts`: `CORAL_AGENT_TOKEN`, `CORAL_ADB` (mặc định `adb`), `CORAL_U2_JAR`, `CORAL_CACHE_DIR` (mặc định `~/.cache/coral`), `CORAL_SERVER_URL` (http/https → suy ra ws/wss); test `config.test.ts`
- [x] T006 [P] Fixture cây Android `fixtures/android/`: `login.xml`, `list-scroll.xml`, `permission-dialog.xml`, `rate-app-dialog.xml`, `never-tap-only-dialog.xml`, `crash-dialog.xml`, `anr-dialog.xml`, `overlay-bottom-sheet.xml`, `keyboard-open.xml` (định dạng `dumpWindowHierarchy`, có cửa sổ app + dialog hệ thống) + `README.md` mô tả từng file
- [x] T007 [P] Fixture test case `fixtures/testcases/`: `valid/*.yaml` (mỗi action §7.1 ít nhất một lần) và `invalid/*.yaml` — **một file cho mỗi mã lỗi** của contracts/testcase-format.md (`var_undeclared`, `unknown_permission`, `platform_coverage`, `duplicate_step_id`, `unsupported_in_phase`, `point_pct_not_last`, thiếu `intent`, `tap` thiếu `target`, sai kiểu tham số) + `expected.json` ghi lỗi mong đợi

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: kiểu dùng chung, interface driver, nền DB/auth/storage/git mà mọi story cần

**⚠️ CRITICAL**: xong phase này mới làm user story

- [x] T008 [P] `packages/shared/src/element.ts`: `ElementNode`, `Bounds`, Zod cho `tree.json` (data-model §5, có trường `android` mở rộng); test `element.test.ts`
- [x] T009 [P] `packages/shared/src/failure-codes.ts` (§8.5) và `packages/shared/src/permissions.ts` (từ vựng §7.5 → permission Android; `notifications` chỉ khi API ≥ 33); test cho cả hai
- [x] T010 [P] `packages/shared/src/redact.ts`: `createRedactor(secrets)` thay mọi chuỗi trùng giá trị secret (≥ 4 ký tự) bằng `***`, áp cho string và JSON lồng nhau; test `redact.test.ts` (nhiều secret, chồng lấn, Unicode)
- [x] T011 `packages/shared/src/protocol/`: `envelope.ts` (`{ v, type, id, ts, re?, payload }`, id UUID v7, ts epoch ms, giới hạn 1 MB) và `messages.ts` — mọi type trong contracts/ws-protocol.md kể cả D33 (`agent.welcome`, `agent.heartbeat`, `item.result`, `error`); `re` bắt buộc với message trả lời; test `protocol.test.ts` (hợp lệ/không hợp lệ cho từng type)
- [x] T012 [P] `packages/shared/src/api/`: Zod request/response cho mọi endpoint của contracts/rest-api.md (snake_case, D12) và schema lỗi chung `{ error: { code, message, details } }`; route server và web (Phase 2) dùng chung; test `api.test.ts`
- [x] T013 `packages/runner/src/core/driver.ts` (`UiDriver`, `TargetLifecycle`, `DeviceDriver` — SPEC §8.1, D28) và `packages/runner/src/testing/fake-driver.ts` (kịch bản màn hình: cây theo bước, tap → chuyển màn, popup chèn vào, crash, log giả); test `fake-driver.test.ts`
- [x] T014 Nền DB `apps/server/src/db/`: `client.ts` (pg pool), `drizzle.config.ts`, script `db:generate` / `db:migrate`, `ids.ts` (uuidv7), `tenant.ts` `withTenant(tenantId, fn)` chạy transaction + `set_config('app.tenant_id', …, true)`; global setup Vitest chạy migration trước `*.int.test.ts` và thêm bước `db:migrate` vào job CI `integration`; luật ESLint: `apps/server/src/routes/**` không được import `db/**` hay `drizzle-orm` — mọi truy cập DB đi qua `apps/server/src/repos/**` có tenant scope (constitution V); test `tenant.int.test.ts` (setting có hiệu lực trong transaction, mất sau commit) + ca mới trong `scripts/eslint-boundaries.test.ts` (route import db → lỗi)
- [x] T015 Schema Drizzle + migration `0001` trong `apps/server/src/db/schema.ts` cho mọi bảng Phase 1 của data-model.md, giữ đúng ràng buộc: `users.email` unique (lowercase); `memberships` PK (tenant_id, user_id), role ∈ owner/admin/member/viewer; `projects` unique (tenant_id, name); `apps` unique (project_id, platform, package_or_bundle_id); `agents` unique token_hash, status ∈ online/offline/revoked; `devices` "unique (agent_id, udid); kind ∈ real/emulator/simulator; status ∈ idle/leased/offline"; `leases` "**partial unique (device_id) where released_at is null**"; `test_cases` "unique (project_id, slug); status ∈ draft/active/quarantined (mặc định draft); source ∈ manual/recorder/ai_prompt/ai_import"; `project_files` PK (project_id, kind); `runs` status ∈ queued/running/passed/failed/cancelled/error; `run_items` unique (run_id, position); `run_steps` unique (run_item_id, step_index); test `schema.int.test.ts` (hai lease mở cùng thiết bị → lỗi unique; mọi bảng nghiệp vụ có `tenant_id not null`)
- [x] T016 Lỗi và validate chung `apps/server/src/http/errors.ts` + plugin Zod cho body/query: định dạng `{ error: { code, message, details } }`, mã 400/401/403/404/409/413/422 (contracts/rest-api.md); tài nguyên của tenant khác → 404; test `errors.test.ts`
- [x] T017 Auth `apps/server/src/auth/`: `password.ts` (argon2id), `tokens.ts` (JWT HS256 15 phút, claim `sub`/`tid`/`role`; refresh token ngẫu nhiên lưu băm, xoay vòng), `routes.ts` (`/auth/login|refresh|logout`, `/me`, cookie `coral_refresh` httpOnly/Secure/SameSite=Strict/Path=/auth, body kèm refresh khi `X-Coral-Client: cli`), rate limit 10 lần sai/15 phút/email, plugin guard gắn `TenantContext`, ghi `audit_log` cho login thành công/thất bại; `apps/server/src/seed.ts` + script `db:seed`; test `tokens.test.ts` + `auth.int.test.ts` (login, refresh xoay vòng, token cũ bị từ chối, khóa sau 10 lần sai)
- [x] T018 [P] Storage `apps/server/src/storage/`: `s3.ts` (client, tạo bucket + lifecycle 30 ngày cho `*/runs/` khi khởi động, presign PUT 10 phút / GET 15 phút), `keys.ts` (builder key theo data-model §4, luôn bắt đầu bằng `<tenant_id>/`); test `keys.test.ts` + `s3.int.test.ts` (PUT/GET qua presigned URL với MinIO)
- [x] T019 [P] Kho git `apps/server/src/git/project-repo-store.ts` (research R8): `init(tenantId, projectId)`, `writeFile(path, content, author, message)` → commit sha (mutex theo project), `readFile(path, commit?)`, `history(path)`; test `project-repo-store.test.ts` trên thư mục tạm (cần `git` CLI)

**Checkpoint**: nền tảng xong — các user story bắt đầu được

---

## Phase 3: User Story 1 - Kiểm tra file test case trước khi chạy (Priority: P1)

**Goal**: `coral validate` báo đúng file, step, trường cho mọi lỗi; `examples/` hợp lệ.

**Independent Test**: `pnpm coral validate examples/*.yaml` exit 0; `pnpm coral validate fixtures/testcases/invalid/*.yaml` exit 1 với lỗi khớp `expected.json` (SC-006). Không cần thiết bị.

- [x] T020 [P] [US1] Zod `coral/testcase@1` trong `packages/shared/src/testcase/schema.ts` đúng contracts/testcase-format.md (discriminated union theo `action`, locator đúng một khóa, `platforms` chỉ mở rộng thêm — D28, giới hạn số như `long_press.ms` 100–10000, `timeout_ms` 100–120000); test `schema.test.ts` (mọi file `fixtures/testcases/valid` và `examples/testcase.example.yaml` hợp lệ; ca sai kiểu)
- [x] T021 [P] [US1] `packages/shared/src/testcase/parse.ts`: đọc YAML bằng `yaml` + `LineCounter`, ánh xạ `path` (`steps[3].target[1]`) → `line`/`column`; test `parse.test.ts`
- [x] T022 [US1] `packages/shared/src/testcase/validate.ts`: lỗi `var_undeclared`, `unknown_permission`, `platform_coverage`, `duplicate_step_id`, `unsupported_in_phase` (`image`, `expect.screen`), `point_pct_not_last`; cảnh báo `no_expect_after_tap`; trả `{ file, step_id, path, code, message, line, column }`; test `validate.test.ts` so với `fixtures/testcases/invalid/expected.json` (SC-006)
- [x] T023 [P] [US1] `packages/shared/src/popups/schema.ts` (`coral/popups@1`, `match` ít nhất một khóa trong `package`/`alert_contains`/`text_contains`/`resource_id`, `name` duy nhất) + lỗi `rule_taps_never_tap`; test `schema.test.ts` (kèm `examples/popups.example.yaml`)
- [x] T024 [US1] Lệnh `coral validate <file…>` trong `packages/cli/src/commands/validate.ts` (nhận loại file theo trường `schema`, `--format text|json`, mã thoát 0/1/2 theo contracts/cli.md); test `validate.test.ts` gọi program với file fixture và kiểm tra output + mã thoát

**Checkpoint**: US1 dùng được độc lập

---

## Phase 4: User Story 2 - Chạy một test case trên emulator ngay tại máy (Priority: P1)

**Goal**: `coral run` chạy tất định trên Android, có artifact từng step trong thư mục cục bộ.

**Independent Test**: logic runner kiểm bằng `FakeDriver` trong CI; 🔌 `pnpm coral run fixtures/testcases/mydemo-login.yaml --device … --app …` pass trên emulator (quickstart §2).

### Lõi runner (không thiết bị)

- [x] T025 [P] [US2] Resolver `packages/runner/src/core/locator/` (`resolve.ts`, `class-match.ts`, `rel.ts`) theo research R4: bỏ locator nền tảng khác, chỉ node `visible` giao màn hình, `android_id` chấp nhận `id/foo`, so khớp `class` tên ngắn (D14), `rel` chọn ứng viên gần anchor nhất có chồng lấn trục còn lại, `class_index` trong `within`, tie-break clickable → sâu nhất → thứ tự duyệt, trả `{ node?, point?, index, degraded }`; test `resolve.test.ts` trên `fixtures/android/*.xml` — mỗi loại locator một ca khớp + một ca rơi xuống dự phòng (SC-004)
- [x] T026 [P] [US2] `packages/runner/src/core/stability.ts`: băm `(class, platform_id, bounds làm tròn 4 px)` bỏ text, hai lần cách 300 ms, tối đa `stable_timeout_ms` 3000 rồi trả `unstable: true`; test với `FakeDriver` + fake timers
- [x] T027 [P] [US2] `packages/runner/src/core/hit-test.ts`: node trên cùng tại điểm = cửa sổ sau cùng → `drawing_order` lớn nhất → sâu nhất; hợp lệ khi thuộc subtree của target; test với `overlay-bottom-sheet.xml`, `keyboard-open.xml`
- [x] T028 [P] [US2] `packages/runner/src/core/expect.ts`: `visible_text`, `visible`, `not_visible` (locator hoặc danh sách), danh sách điều kiện cùng đúng, thăm dò 250 ms tới `timeout_ms` (mặc định 5000); test với `FakeDriver`
- [x] T029 [P] [US2] `packages/runner/src/core/interpolate.ts`: `${var:name}`, `${secret:NAME}`; liệt kê secret thiếu **trước** khi chạy; test `interpolate.test.ts`
- [x] T030 [US2] `packages/runner/src/core/actions.ts`: mọi action §7.1 qua `UiDriver`/`TargetLifecycle` — tap vào tâm bounds đọc lúc chạy sau hit-test, `long_press` ms, `type` (tap focus → `driver.type`, `clear_first`), `clear`, `swipe` theo hướng/`distance_pct` hoặc `from`/`to`, `scroll_to` tối đa `max_swipes`, `back`, `hide_keyboard`, `wait` ms/`until`, `assert`, `open_deeplink`, `launch`; test `actions.test.ts` với `FakeDriver`
- [x] T031 [P] [US2] `packages/runner/src/core/artifacts.ts` (interface `ArtifactSink`) và `packages/runner/src/sinks/local-dir.ts` (bố cục thư mục contracts/cli.md, text artifact đi qua redactor); test `local-dir.test.ts` trên thư mục tạm
- [x] T032 [US2] Vòng lặp `packages/runner/src/core/run-testcase.ts` theo §8.2: chuẩn bị (precondition qua `TargetLifecycle`), mỗi step chờ ổn định → resolve → thao tác → expect → artifact; `degraded`, mã lỗi §8.5, dừng ở step lỗi đầu tiên, lưu `device.log` khi lỗi, phát sự kiện `step`/`item` cho người gọi, hủy bằng `AbortSignal`; hook popup guard (mặc định không làm gì); test `run-testcase.test.ts` với `FakeDriver`: pass, `TARGET_NOT_FOUND`, `EXPECT_FAILED`, `degraded`, hủy giữa chừng

### Driver Android

- [x] T033 [P] [US2] `packages/runner/src/drivers/android/adb.ts`: `execFile` có timeout, `devices -l` → danh sách, `getprop` (model, release, sdk), nhận biết emulator; test `adb.test.ts` với output ghi sẵn
- [x] T034 [P] [US2] `packages/runner/src/drivers/android/u2-assets.ts`: tải wheel `uiautomator2==3.7.0` từ PyPI, kiểm sha256 wheel `731bf4e26e35cd440cd165b399b8a4d4b795178d78b9243769e336aee6dce985` và jar `0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6`, giải nén bằng `fflate`, cache `<CORAL_CACHE_DIR>/u2/0.4.0/u2.jar`, ưu tiên `CORAL_U2_JAR`; test `u2-assets.test.ts` với fetch giả + zip nhỏ tạo trong test
- [x] T035 [P] [US2] `packages/runner/src/drivers/android/hierarchy.ts`: XML → `ElementNode[]` theo research R3 (bounds, `visible-to-user`, `ref` đường dẫn chỉ số, `window_index`, `drawing_order`); test `hierarchy.test.ts` trên mọi `fixtures/android/*.xml`
- [x] T036 [US2] `packages/runner/src/drivers/android/u2-client.ts` + `u2-server.ts` theo contracts/android-u2.md: JSON-RPC 2.0, timeout 10 s, ánh xạ lỗi, khởi động lại một lần khi `UiAutomation not connected`/`DeadObjectException`; push jar khi md5 khác, `app_process`, `adb forward`, chờ `deviceInfo` ≤ 30 s, `already registered` → `DRIVER_ERROR` có hướng dẫn; test `u2-client.test.ts` với HTTP server giả + adb giả
- [x] T037 [US2] `packages/runner/src/drivers/android/lifecycle.ts` theo research R7: `adb install -r -d` khi sha256 khác bản đã cài (ghi nhớ theo thiết bị), `pm clear`, `pm grant` (ánh xạ §7.5), animation = 0 và khôi phục trên máy thật, `launch` bằng `monkey`, `open_deeplink` bằng `am start -W`, `logcat` từ mốc thời gian, phát hiện crash/ANR (`pidof`, `logcat -b crash`, dialog `android:id/aerr_*`); test `lifecycle.test.ts` với adb giả (kiểm đúng lệnh, chỉ đụng package đang test — P6)
- [x] T038 [US2] `packages/runner/src/drivers/android/android-driver.ts` cài `DeviceDriver`: `tree` (u2 dump + hierarchy), `screenshot` (`adb exec-out screencap -p`), `windowSize` (`deviceInfo`), `tapAt`/`longPressAt`/`swipe`/`back`, `type` bằng `setText({ focused: true })`; test `android-driver.test.ts` với client/adb giả
- [ ] T039 [US2] 🔌 `packages/runner/src/drivers/android/android-driver.device.test.ts`: trên emulator thật — khởi động u2, dump cây, tap, gõ tiếng Việt có dấu đúng từng ký tự, screenshot PNG, `already registered` khi có client khác
- [x] T040 [US2] Lệnh `coral devices` (`packages/cli/src/commands/devices.ts`) và `coral run` (`packages/cli/src/commands/run.ts`) theo contracts/cli.md: secret từ `CORAL_SECRET_<NAME>` (thiếu → exit 2 trước khi đụng thiết bị), luật popup mặc định đóng gói sẵn, `--apk`, `--out`, mã thoát 0/1/2; test case không có `android` trong `platforms` → exit 2 `platform_mismatch`; thêm `coral-results/` vào `.gitignore`; test `run.test.ts` với factory driver trả `FakeDriver`
- [ ] T041 [US2] 🔌 `fixtures/testcases/mydemo-login.yaml` cho Sauce Labs My Demo App (xác minh resource-id thật trên emulator, research R15) + `packages/cli/src/commands/run.device.test.ts` chạy nó bằng `coral run`, kiểm pass và thời gian < 60 s (SC-005)

**Checkpoint**: US1 + US2 chạy được độc lập

---

## Phase 5: User Story 3 - Chạy test case thông qua server (Priority: P1) 🎯 DoD

**Goal**: người vận hành lưu test case, tạo run qua API; agent chạy và báo kết quả từng step; xem được kết quả + ảnh.

**Independent Test**: `e2e.int.test.ts` chạy trọn luồng với agent giả dùng `FakeDriver` (CI); 🔌 `scripts/phase1-e2e.mjs --runs 5` trên emulator → 5/5 (SC-001).

### Server — tài nguyên

- [x] T042 [P] [US3] Project + app: `apps/server/src/repos/projects.ts`, `repos/apps.ts`, `routes/projects.ts` (`GET/POST /projects`, `GET/POST /projects/:id/apps`); tạo project → khởi tạo kho git với `popups.yaml` mặc định + `README.md`, ghi `project_files`; test `projects.int.test.ts` (kể cả tenant khác → 404)
- [x] T043 [P] [US3] Build: `apps/server/src/repos/builds.ts`, `routes/builds.ts` (`POST/GET /apps/:id/builds`, multipart stream lên S3, tính sha256 + size trên đường truyền, giới hạn 500 MB → 413); test `builds.int.test.ts`
- [x] T044 [US3] Test case + luật popup: `apps/server/src/repos/test-cases.ts`, `routes/testcases.ts`, `routes/popups.ts` theo contracts/rest-api.md — validate (US1) trước khi commit, `source = manual`, `status` mặc định `draft`, `PUT` cần `base_commit` (khác head → 409), `GET ?commit=`, `/history`; test `testcases.int.test.ts` (tạo, sửa, xung đột, nội dung sai → 400 với `details`)
- [x] T045 [P] [US3] Agent + thiết bị: `apps/server/src/repos/agents.ts`, `repos/devices.ts`, `routes/agents.ts` (`POST /agents` trả token `coral_agt_…` **một lần**, lưu SHA-256; `GET /agents`; `POST /agents/:id/revoke` đóng kết nối), `routes/devices.ts`; ghi `audit_log`; test `agents.int.test.ts`

### Server — kênh agent và run

- [x] T046 [US3] Gateway `apps/server/src/agents/gateway.ts` + `registry.ts`: `WS /ws/agent` xác thực header (sai/thu hồi → 4401), `agent.hello` → `agent.welcome`, upsert `devices` từ hello/`device.update`, `agent.heartbeat` cập nhật `last_seen_at` + gia hạn lease, mất 3 heartbeat → agent/thiết bị `offline`, message sai → `error` (quá 20/phút → 4400); chu kỳ cấu hình được cho test; test `gateway.int.test.ts` với client `ws`
- [x] T047 [US3] Tạo run `apps/server/src/repos/runs.ts`, `runs/create.ts` + `routes/runs.ts` (`POST /runs`, ghi `audit_log`): test case cùng project, `platforms` có `android`, thiết bị Android cùng tenant, build thuộc app của project, secret tham chiếu có trong `CORAL_SECRET_*` (thiếu → 422 `missing_secrets`); tạo `runs` + `run_items` ghi `commit`; đẩy vào `run-dispatch`; test `runs-create.int.test.ts`
- [x] T048 [US3] Dispatcher + lease `apps/server/src/runs/dispatcher.ts`, `lease.ts`, `apps/server/src/repos/leases.ts` (research R9): BullMQ `run-dispatch` lấy lease trong transaction (dựa vào partial unique index), thiết bị bận/offline → hẹn lại 2 s → tối đa 10 s tới queue timeout 10 phút (`error`/`TIMEOUT`); gửi `job.assign` (build presigned GET, YAML + `popups.yaml` tại commit, secret, limits); không có `job.ack` trong 30 s → giải phóng lease, thử lại một lần; `run-timeout` 30 phút → `job.cancel` + `TIMEOUT`; test `lease.int.test.ts`: 10 run đồng thời một thiết bị → không bao giờ có hai lease mở, chạy lần lượt (SC-007)
- [x] T049 [US3] Nhận kết quả `apps/server/src/runs/ingest.ts`: `job.ack` → `running`; `step.result` upsert, bỏ trùng `(run_item_id, step_index)`; `item.result`; `artifact.request_upload` → presigned PUT theo key data-model §4; `job.done` → trạng thái cuối, giải phóng lease, thiết bị `idle`; `POST /runs/:id/cancel` → `job.cancel`; agent offline khi đang chạy → item `error`/`DEVICE_OFFLINE`, lease `release_reason = agent_offline`; ghi `audit_log` khi hủy run; `apps/server/src/runs/lease-sweeper.ts`: khi server khởi động và mỗi 30 s, giải phóng lease có `expires_at < now()` (`release_reason = timeout`), item đang chạy trên lease đó → `error`/`DEVICE_OFFLINE`, run tương ứng kết thúc, thiết bị trở lại `idle` nếu agent còn online; test `ingest.int.test.ts` + `offline.int.test.ts` (SC-009 với heartbeat rút ngắn) + `lease-sweeper.int.test.ts` (lease kẹt sau khi server khởi động lại được dọn)
- [x] T050 [US3] API đọc run `apps/server/src/routes/runs.ts`: `GET /runs` (lọc + cursor), `GET /runs/:id`, `GET /runs/:id/items/:itemId/steps` (presigned GET 15 phút cho screenshot/tree/log); `GET /health/ready` (không cần đăng nhập, chỉ trả `{ status: "ok" | "not_ready" }`, không lộ chi tiết hạ tầng); test `runs-read.int.test.ts`

### Agent

- [x] T051 [P] [US3] `apps/agent/src/connection.ts`: `ws` với header `Authorization`, kết nối lại backoff 1 → 30 s, gửi `agent.hello`, chờ `agent.welcome`, heartbeat theo chu kỳ server trả, hàng chờ tối đa 200 message khi mất kết nối, validate mọi message nhận bằng Zod; test `connection.test.ts` với WS server giả trong tiến trình
- [x] T052 [P] [US3] `apps/agent/src/devices.ts`: thăm dò `adb devices` mỗi 5 s → `device.update` (added/removed/changed); thiết bị `unauthorized` không được báo lên, chỉ ghi cảnh báo một lần; test `devices.test.ts` với adb giả
- [x] T053 [US3] `apps/agent/src/jobs.ts` + `upload-sink.ts`: mỗi thiết bị một job (bận → `job.reject`), tải build theo presigned URL và cache theo sha256, chạy `runTestCase` cho từng item, gửi `step.result`/`item.result`/`job.done`, `ArtifactSink` xin presigned PUT rồi PUT lên S3, `job.cancel` → `AbortController` dừng sau thao tác hiện tại rồi dọn dẹp tối thiểu (khôi phục animation trên máy thật, dừng server u2; không gỡ app, không xóa dữ liệu); test `jobs.test.ts` với `FakeDriver` + server giả
- [x] T054 [US3] Nối dây `apps/agent/src/main.ts` (thay probe `/health` của Phase 0 bằng connection + devices + jobs, tắt êm) và `apps/server/src/main.ts` (db, redis, s3, gateway, dispatcher); test `e2e.int.test.ts`: server thật + agent thật dùng `FakeDriver` → tạo project/app/build/test case/run → `passed`, mọi step có screenshot + tree tải được (HTTP 200) trong ≤ 10 s tính từ `job.done` (SC-002)
- [x] T055 [US3] `scripts/phase1-e2e.mjs` theo quickstart §3–§5 (`--apk`, `--testcase`, `--runs`, `--scan-secrets`, `--run`); test `scripts/phase1-e2e.int.test.ts` chạy script với agent `FakeDriver` và `--runs 2`
- [ ] T056 [US3] 🔌 DoD trên máy Huynh: `node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-login.yaml --runs 5` → 5/5 pass, ghi kết quả vào `specs/002-phase-1-android-runner/quickstart.md` (SC-001)

**Checkpoint**: DoD chính của Phase 1 đạt khi T056 xong

---

## Phase 6: User Story 4 - Popup không làm hỏng test (Priority: P2)

**Goal**: guard lớp 2 xử lý popup theo luật, tôn trọng `never_tap`, không đóng crash/ANR.

**Independent Test**: unit trên fixture popup (CI); 🔌 test quyền camera không cấp trước pass 5/5 (SC-003).

- [x] T057 [P] [US4] `packages/shared/src/popups/match.ts`: so khớp luật (mọi khóa `match` cùng đúng; `package`, `alert_contains`, `text_contains`, `resource_id`), chọn nút theo thứ tự `tap_any`, lọc `never_tap` (không phân biệt hoa/thường, chuẩn hóa khoảng trắng); test `match.test.ts`
- [x] T058 [US4] `packages/runner/src/core/popup-guard.ts` theo research R6: nhận diện popup (package khác app trừ `com.android.systemui`, panel dialog), gói permissioncontroller/packageinstaller, dialog crash/ANR → trả `APP_CRASHED`/`APP_NOT_RESPONDING` thay vì đóng, ngoại lệ "step đang nhắm popup", bỏ qua toast, tối đa 3 popup/step → `BLOCKED_BY_POPUP` (D25), ghi `popups_handled`; test `popup-guard.test.ts` trên `permission-dialog.xml`, `rate-app-dialog.xml`, `never-tap-only-dialog.xml`, `crash-dialog.xml`, `anr-dialog.xml`, chuỗi 4 popup
- [x] T059 [US4] Gắn guard vào `packages/runner/src/core/run-testcase.ts` tại 3 điểm (sau launch, khi không thấy target, khi `expect` fail) + truyền luật từ `coral run` và `job.assign`; test `run-testcase.popup.test.ts` với `FakeDriver` chèn popup quyền giữa hai step
- [ ] T060 [US4] 🔌 `fixtures/testcases/mydemo-camera-permission.yaml` (không `grant_permissions`, `app_state: fresh`) + chạy `scripts/phase1-e2e.mjs --runs 5 --expect-popup android_permission` trên emulator → 5/5, mỗi run có `popups_handled` `android_permission` (SC-003)

---

## Phase 7: User Story 5 - Kết quả an toàn và đủ để chẩn đoán (Priority: P2)

**Goal**: bằng chứng đủ cho mỗi step, không lộ secret, artifact nằm trong vùng của tenant.

**Independent Test**: quét secret trên kết quả run giả (CI) và run thật (🔌) → 0 (SC-008).

- [x] T061 [P] [US5] Che secret ở mọi đầu ra: sự kiện runner, `tree.json`, `device.log`, `result.json`, log pino của agent (formatter dùng redactor), server không bao giờ log payload `job.assign`; test `redaction.test.ts` (runner + agent) quét toàn bộ đầu ra của một run `FakeDriver` có secret → 0 lần xuất hiện
- [x] T062 [P] [US5] Ràng buộc tenant cho artifact: `artifact.request_upload` chỉ nhận run của tenant sở hữu agent, key luôn do server sinh; test `artifacts-tenant.int.test.ts` (agent tenant B xin upload cho run tenant A → `error`; liệt kê object chỉ trong prefix tenant)
- [ ] T063 [US5] 🔌 `scripts/phase1-e2e.mjs --scan-secrets --run <id>` trên run thật của T056 → 0 (SC-008), ghi kết quả vào quickstart

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T064 [P] Đồng bộ tài liệu: SPEC §16 thêm `GET /testcases/:id/history`, `POST /agents/:id/revoke`, `GET /health/ready`; SPEC §20 Q3 ghi cần rà license `u2.jar` trước khi thương mại hóa (research R2); `CLAUDE.md` "Lệnh thường dùng" thêm `db:migrate`, `db:seed`, `test:int`, `coral validate|devices|run`; `README.md`
- [ ] T065 [P] Kiểm tra SC-010: test `scripts/no-ai.test.ts` khẳng định closure phụ thuộc của `@coral/runner`, `@coral/agent`, `@coral/cli` trong lockfile không có LLM SDK hay MCP SDK
- [ ] T066 Chạy đủ cổng chất lượng + quickstart §1 và §6 trong container (format, lint, boundaries, typecheck, test, test:int, build); push; xác nhận CI xanh cả 3 job (`checks`, `infra`, `integration`)
- [ ] T067 🔌 Sau khi Huynh chạy quickstart §2–§5, §7 trên máy thật: đánh dấu `[x]` Phase 1 trong `docs/ROADMAP.md`, báo cáo từng mục DoD, chuyển "Phase hiện tại" → Phase 2

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001–T007)**: bắt đầu ngay; T002 cần T001.
- **Foundational (T008–T019)**: cần Setup. T011 cần T008. T012 (API schema) độc lập, T016 (lỗi HTTP) dùng T012. T014 → T015 → T017. T018, T019 độc lập.
- **US1 (T020–T024)**: cần T007 (fixture) + Foundational shared (T008–T010).
- **US2 (T025–T041)**: cần T013 (driver interface) + US1 (runner đọc test case bằng schema/validate). Lõi runner (T025–T032) song song với driver Android (T033–T038).
- **US3 (T042–T056)**: cần Foundational server (T012, T014–T019) + US1 (validate khi lưu) + US2 lõi runner (agent chạy `runTestCase`). Phần server (T042–T050) song song với agent (T051–T053).
- **US4 (T057–T060)**: cần T032 (vòng lặp); T060 cần T055 (script e2e).
- **US5 (T061–T063)**: cần US2 + US3.
- **Polish (T064–T067)**: cuối cùng.

### User Story Dependencies

- **US1 (P1)**: độc lập sau Foundational.
- **US2 (P1)**: dùng schema của US1.
- **US3 (P1)**: dùng US1 (validate) và lõi US2 (runner); kiểm được hoàn toàn bằng `FakeDriver`.
- **US4 (P2)**: gắn vào vòng lặp US2; kiểm độc lập bằng fixture popup.
- **US5 (P2)**: cắt ngang US2/US3.

### Within Each User Story

- Test viết cùng commit với code; test phải fail trước khi code xong phần tương ứng.
- Schema/kiểu → logic thuần → driver/route → nối dây → test tích hợp → 🔌 kiểm trên thiết bị.

### Parallel Opportunities

- Setup: T004, T005, T006, T007.
- Foundational: T008, T009, T010, T012 song song; T018, T019 song song với chuỗi DB.
- US1: T020, T021, T023.
- US2: T025–T029, T031 (lõi) song song với T033–T035 (driver).
- US3: T042, T043, T045 song song; T051, T052 song song với phần server.
- US4: T057 song song với phần còn lại của US3.
- US5: T061, T062.

---

## Parallel Example: User Story 2

```bash
# Lõi runner (thuần, không thiết bị):
Task: "Resolver in packages/runner/src/core/locator/resolve.ts"
Task: "waitForStable in packages/runner/src/core/stability.ts"
Task: "Hit-test in packages/runner/src/core/hit-test.ts"
Task: "checkExpect in packages/runner/src/core/expect.ts"

# Driver Android (song song với lõi):
Task: "adb wrapper in packages/runner/src/drivers/android/adb.ts"
Task: "u2.jar assets in packages/runner/src/drivers/android/u2-assets.ts"
Task: "Hierarchy parser in packages/runner/src/drivers/android/hierarchy.ts"
```

---

## Implementation Strategy

### MVP First

1. Setup + Foundational.
2. US1 (validate) → dừng, kiểm `coral validate`.
3. US2 lõi runner + driver → 🔌 Huynh chạy `coral run` trên emulator (T039, T041).
4. US3 → `e2e.int.test.ts` xanh trong CI → 🔌 T056 (DoD 5/5).

### Incremental Delivery

1. Foundation → US1 → US2 (chạy cục bộ) → US3 (qua server, DoD) → US4 (popup, DoD) → US5 (secret, tenant).
2. Mỗi user story là một nhóm commit có thể demo riêng; dừng ở mỗi checkpoint để Huynh duyệt (CLAUDE.md "Cách làm việc").

### Phân công theo môi trường

- **Container / CI** (Claude làm được): mọi task không có 🔌 — unit, tích hợp, `FakeDriver`, agent giả.
- **Máy Huynh** (có emulator): T039, T041, T056, T060, T063, T067 — Claude chuẩn bị test/script, Huynh chạy và gửi kết quả (hoặc log) để sửa tiếp.

---

## Notes

- [P] = khác file, không phụ thuộc task chưa xong.
- Mỗi task một commit (code + test); đánh `[x]` ở đây và trong `docs/ROADMAP.md` khi xong nhóm tương ứng.
- Không sửa migration đã chạy; thêm migration mới.
- Tránh: task mơ hồ, hai task sửa cùng file song song, phụ thuộc chéo phá tính độc lập của story.
