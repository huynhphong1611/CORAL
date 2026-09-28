# Research: Phase 0 — chốt tech stack và rà soát SPEC

**Feature**: `001-phase-0-foundation` · **Date**: 2026-09-28 · Kết quả đã ghi vào `docs/SPEC.md` (§19, §21 D07–D27).

## 1. Chốt tech stack (SPEC §19, D07)

| Hạng mục | Quyết định | Lý do | Phương án đã cân nhắc |
|---|---|---|---|
| Runtime | Node.js 24 LTS, ESM | LTS hiện hành; `fetch`, `--env-file`, `AbortSignal.timeout` có sẵn | Node 22 (sắp hết active LTS), Bun (hệ sinh thái Appium/WebdriverIO chưa chắc) |
| Monorepo | pnpm 10 + Turborepo 2 | Theo SPEC 0.1; pnpm strict, nhanh; turbo cache + chạy `dev` song song | Nx (nặng), npm workspaces (thiếu strictness) |
| Gói nội bộ | Xuất thẳng source TS (JIT), app tự bundle | Không có bước build gói → dev nhanh, không lệch `dist` | Build từng gói bằng `tsc -b` (chậm, phức tạp với Vite) |
| Build app | `tsdown` (server/agent/cli), Vite (web); `tsx` khi dev | tsdown là kế nhiệm tsup (tsup chỉ còn bảo trì) | tsup, esbuild thuần |
| Server | Fastify 5 + `@fastify/websocket`, pino | Nhẹ, schema-first, logger JSON sẵn | Express (chậm, không schema), NestJS (nặng) |
| Validate | Zod 4 | Một schema cho YAML, WS, API, output LLM, env | Valibot, TypeBox |
| Auth | `@node-rs/argon2`, `jose` | Binary dựng sẵn; JWT chuẩn, chạy mọi runtime | `argon2` (cần node-gyp), `jsonwebtoken` (CJS, cũ) |
| DB | Postgres 17 + Drizzle + `pg`; UUID v7 ở app (`uuidv7`) | RLS, migration SQL rõ; PG17 chưa có `uuidv7()` | Prisma (RLS khó), PG18 (`uuidv7()` sẵn nhưng image mới đổi layout volume) |
| Queue | Redis 7 + BullMQ 5 | Theo SPEC; hỗ trợ delay, retry, lock | pg-boss (đỡ một dịch vụ nhưng kém cho lease ngắn) |
| Object storage | S3 API (`@aws-sdk/client-s3`); dev dùng image `pgsty/minio` (D26) | `minio/minio` đã bị gỡ khỏi Docker Hub; fork dùng y hệt MinIO; S3 API chuẩn nên thay được store (R8) | RustFS, SeaweedFS (cấu hình khác MinIO), `bitnamilegacy/minio` (không còn cập nhật) |
| Git | `simple-git` | Bọc `git` CLI, đủ diff/commit | isomorphic-git (chậm với repo lớn) |
| YAML | `yaml` (eemeli) | Giữ comment/format khi sửa → diff heal sạch | js-yaml (mất comment) |
| Web | React 19 + Vite 8 + TanStack Query; TanStack Router + Tailwind từ Phase 2 | Theo SPEC; router type-safe | React Router, Next.js (không cần SSR) |
| Agent — Android | Client TS gọi thẳng `u2.jar` (openatx/uiautomator2 3.7, JSON-RPC 2.0 qua `adb forward`) (D27) | Theo đề xuất của Huynh: không có chặng Appium server, không tạo session, không cài APK test; `dumpWindowHierarchy` nhanh | Appium 3 + UiAutomator2 driver (chậm hơn, nặng hơn); gọi thẳng APK `appium-uiautomator2-server` (phải cài 2 APK + instrumentation); dùng thư viện Python `uiautomator2` (agent phải có Python, trái D07) |
| Agent — iOS | WebdriverIO (remote) → Appium 3 XCUITest | Appium lo build/ký WebDriverAgent | Gọi thẳng WDA (xem lại ở Phase 5) |
| So khớp ảnh | OpenCV WASM (`@techstark/opencv-js`) | Android không còn Appium images plugin (D27) | sharp + so khớp tự viết |
| CLI | commander | Phổ biến, ổn định | citty, yargs |
| Test | Vitest 5 projects; device test = `*.device.test.ts` | Một lệnh cho cả repo; lọc bằng tên file | Tag trong tên test (dễ quên) |
| Lint | ESLint 10 flat + typescript-eslint type-aware, Prettier 3 | `no-floating-promises` bắt lỗi async thiết bị | Biome (chưa có luật type-aware tương đương) |
| Ranh giới | ESLint `no-restricted-imports` + `scripts/check-boundaries.mjs` | Bắt cả import trong code lẫn phụ thuộc bắc cầu trong lockfile | dependency-cruiser (không đọc lockfile) |
| Spec | GitHub Spec Kit v1.0.12 (skill `/speckit-*`) | Chủ dự án yêu cầu; chuẩn hóa spec → plan → tasks | — |
| TypeScript | 6.0 | typescript-eslint 8 hỗ trợ `<6.1`; TS 7 (native) để sau | TS 7.0 (chưa có lint type-aware) |

## 2. Rà soát SPEC 0.1 — mâu thuẫn và điểm chưa rõ

Mỗi mục: vấn đề → quyết định (đã được chủ dự án đồng ý ngày 2026-09-28) → nơi ghi.

### 2.1 Mâu thuẫn

| # | Vấn đề | Quyết định | Ghi ở |
|---|---|---|---|
| M1 | CLAUDE.md/P5 nói "mọi bảng có `tenant_id`", nhưng §6 có `tenants`, `users`, `refresh_tokens` không có `tenant_id` | Ba bảng này là bảng định danh toàn cục, chỉ module auth truy cập; mọi bảng **nghiệp vụ** có `tenant_id` | D10, §2, §6 |
| M2 | §17 "server không giữ state" nhưng `projects.git_repo_path` (repo trên đĩa server) và kết nối WS agent nằm trong process | Chấp nhận một instance đến hết Phase 5; repo trên volume `CORAL_DATA_DIR` sau interface `ProjectRepoStore`; mở rộng bằng Redis pub/sub + git server | D15, §13.1, §17, R10 |
| M3 | `never_tap` chứa "Xóa", "Đăng xuất" và P6 bảo "tôn trọng never_tap" → test chức năng xóa/đăng xuất sẽ không chạy được | `never_tap` chỉ áp cho hành động máy tự quyết (guard, resolver, Explorer, patch Healer, bản nháp Test writer), không áp cho step người đã duyệt | D13, §9.4 |
| M4 | P1 chỉ cấm `apps/agent`, nhưng `coral run` (trong `packages/cli`) cần runner đang nằm ở `apps/agent` → hoặc CLI import app, hoặc CLI thoát khỏi luật P1 | Luật tổng quát D08; runner tách ra `packages/runner` ở Phase 1 | D08, D09, §4.2 |
| M5 | §8.7 (`locator_refresh`) và §9.3 (luật popup mới) đều "tạo proposal", nhưng `heal_proposals` chỉ có `classification` heal/bug/flaky/env và bắt buộc gắn test case; §12.2 nói reject → "bug hoặc wontfix" nhưng `status` chỉ có pending/approved/rejected | Thêm `kind`, `target_path`, `rejection_outcome`, trạng thái `superseded`; `bugs.status` | D17, §6, §12.2 |
| M6 | §8.2 luôn `resolve(step.target)`, nhưng `launch`, `back`, `wait`, `assert`, `hide_keyboard`, `open_deeplink` không có target | Bảng tham số từng action; target tùy chọn/không có tùy action | D14, §7.1, §8.2 |
| M7 | `expect.screen` cần fingerprint + app map, nhưng thuật toán fingerprint nằm ở Explorer (server) và `job.assign` không gửi app map | Fingerprint ở `packages/shared`; `job.assign` gửi fingerprint cần thiết | D24, §7.3, §15 |
| M8 | §6 "UUID v7" nhưng §19 "Postgres 16+" không có hàm `uuidv7()` | Sinh ở ứng dụng | D11 |
| M9 | §9.2 nói guard chạy "khi vừa mở app" nhưng §8.2 không có bước này; không giới hạn số lần → có thể lặp vô hạn | Guard chạy sau launch; tối đa 3 popup mỗi step rồi `BLOCKED_BY_POPUP` | D25, §8.2 |

### 2.2 Chưa rõ

| # | Vấn đề | Quyết định | Ghi ở |
|---|---|---|---|
| C1 | `variables` được khai báo nhưng không có cú pháp tham chiếu trong step | `${var:name}`; chỉ có hai dạng nội suy `${secret:…}`, `${var:…}` | D14, §7.4 |
| C2 | `class: Button` trong ví dụ `rel` — là tên đầy đủ hay tên ngắn? Class khác nhau giữa Android/iOS | Chấp nhận cả hai; tên ngắn khớp đoạn cuối | D14, §7.2 |
| C3 | `expect.visible` nhận một locator → nếu là `android_id` thì trên iOS điều kiện vô nghĩa | Nhận locator hoặc danh sách; `coral validate` kiểm tra độ phủ nền tảng | D14, §7.2, §7.3 |
| C4 | `swipe` "hướng hoặc từ/đến" — đơn vị? `scroll_to` giới hạn? `type` không có target? | Bảng §7.1 (điểm `point_pct`, `distance_pct`, `max_swipes`, gõ vào element đang focus) | D14, §7.1 |
| C5 | `grant_permissions: [notifications, location]` — tên trừu tượng ánh xạ thế nào? | Từ vựng cố định §7.5, ánh xạ trong `packages/shared` | §7.5 |
| C6 | `point_pct` so với cửa sổ hay màn hình vật lý, hướng xoay? | Theo `windowSize()` ở hướng hiện tại; mặc định dọc | D14, §8.4 |
| C7 | Live view / Recorder / Explorer có cần lease không, có chạy song song với run không? | Mọi điều khiển cần lease (bảng `leases`); xem live view không cần | D16, §6 |
| C8 | Test case: git hay DB là nguồn sự thật? `status` lưu đâu? Ai đặt `quarantined`? | Git cho nội dung, DB là chỉ mục; `status` chỉ ở DB; `quarantined` đặt thủ công (tự động để sau) | D15, §13.1 |
| C9 | Secret cấp tenant hay project? Agent nhận giá trị thế nào? Che trong artifact? Phase 1 chưa có bảng `secrets` | `project_id` tùy chọn; giá trị giải mã gửi trong `job.assign`; agent che `***`; trước Phase 5 đọc `CORAL_SECRET_<NAME>` | D19, §6, §8.6, §17 |
| C10 | `brains.yaml` "theo tenant" lưu ở đâu? API key của ai trả tiền? | `tenants.settings`; key là secret cấp tenant (BYOK) + key mặc định nền tảng tùy chọn | D20, §14.3 |
| C11 | Copilot SDK là agent runtime (chạy Copilot CLI), còn preview; chưa rõ nhận ảnh và điều khoản dùng multi-tenant | Làm sau cùng, sau cờ, token của tenant; DoD Phase 3 không phụ thuộc | D20, R7 |
| C12 | Envelope WS thiếu trường ghép cặp request/response; `ts` không rõ định dạng; frame live view base64 trong JSON tốn băng thông | `re`, `ts` epoch ms, binary frame | D18, §15 |
| C13 | Agent mất kết nối giữa run thì lease/run ra sao? | `DEVICE_OFFLINE`, giải phóng lease, không tự retry | D18, §15 |
| C14 | Web lưu access/refresh token ở đâu? | Access trong bộ nhớ; refresh trong cookie httpOnly | D23, §5.2 |
| C15 | Quy ước tên trường: SPEC dùng `snake_case` (`timeout_ms`, `platform_id`) nhưng code TS thường `camelCase` | `snake_case` trên dây, `camelCase` trong code | D12 |
| C16 | "Tag `@device`" — Vitest không có tag ổn định | Tên file `*.device.test.ts` | D21 |
| C17 | `packages/brain` ở Phase 0 là "interface + adapters, chưa implement" — tạo interface ngay? | Chỉ khung; interface ở Phase 3 (phụ thuộc `ElementNode` của Phase 1) | spec.md Clarifications |
| C18 | `describeScreen` trong interface Brain không được luồng nào dùng | Explorer dùng để đặt `name` cho màn hình mới | §10 |
| C19 | Thư mục `examples/` được nhắc nhưng chưa có trong repo | Tạo `testcase`, `popups`, `brains` example theo SPEC đã làm rõ | examples/ |

### 2.3 Rủi ro mới ghi nhận

- **R7** Copilot SDK (xem C11).
- **R8** MinIO ngừng phát hành bản community; khi cài thử ngày 2026-09-28, repo `minio/minio` trên Docker Hub đã không còn → dùng fork `pgsty/minio` (D26), chỉ dùng S3 API chuẩn.
- **R9** Snapshot PNG trong git làm repo project phình → cân nhắc Git LFS / lưu theo content hash.
- **R10** Server một instance (M2).
- **R11** Giao thức JSON-RPC của `u2.jar` không có tài liệu chính thức → ghim phiên bản, có bộ `*.device.test.ts`, giữ khả năng thay bằng Appium UiAutomator2 sau interface `DeviceDriver` (D27).
