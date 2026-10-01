# coral — Đặc tả hệ thống (SPEC)

> **CORAL** = **C**ontinuous **O**bservation, **R**epair & **A**daptive **L**earning
> *coral — tests that grow back.*

| | |
|---|---|
| Phiên bản | 0.2 (draft) |
| Ngày | 2026-10-01 |
| Chủ dự án | Huynh |
| Trạng thái | Phase 0–2 xong; đang làm Phase 3 (Brain layer, Explorer, Test writer — D41–D46). Tech stack chốt ở §19 (D07) |

Tài liệu này là **nguồn sự thật** về kiến trúc và hành vi của coral. Kế hoạch triển khai theo giai đoạn nằm ở `docs/ROADMAP.md`. Quy ước code và cách làm việc nằm ở `CLAUDE.md`. Khi có quyết định lệch khỏi tài liệu này, cập nhật mục liên quan và ghi vào §21 Decision log. Ký hiệu `(Dxx)` trỏ tới dòng tương ứng trong Decision log.

---

## 1. Bối cảnh và mục tiêu

### 1.1 Vấn đề
Test UI mobile (Android/iOS) tốn công viết, và còn tốn công hơn để bảo trì: mỗi lần UI đổi (đổi id, dời nút, thêm popup) là script gãy.

### 1.2 Mục tiêu
coral là hệ thống test tự động cho app mobile, trong đó:

1. AI **nhìn màn hình, khám phá app** và **viết test case**.
2. Test case được **lưu lại** và **chạy lại không cần AI** (nhanh, rẻ, ổn định).
3. Khi test lỗi, AI **chẩn đoán**: nếu UI đổi thì **đề xuất tự sửa**, nếu là lỗi thật thì **báo bug**.
4. Hệ thống **tích lũy tri thức** (app map, skills, luật popup, lịch sử heal), nên càng chạy càng ít cần AI.
5. "Bộ não" AI **thay được**: Claude, Gemini, GitHub Copilot.
6. Có **web UI** tương tác (xem màn hình thiết bị trực tiếp, ghi test, duyệt heal) và **quản lý user riêng** (multi-tenant).

### 1.3 Ngoài phạm vi (giai đoạn đầu)
- Tự nuôi device farm; test web; load/performance test.
- Tự động hóa thanh toán thật, OTP thật, captcha (chỉ hỗ trợ qua hook/skill do user cung cấp).
- Tự merge thay đổi test case mà không có người duyệt.

---

## 2. Nguyên tắc cốt lõi (bất biến)

| # | Nguyên tắc | Hệ quả khi code |
|---|---|---|
| P1 | **AI viết, script chạy** | Runner (`packages/runner`, `apps/agent`) **không được import LLM SDK**. LLM chỉ được dùng ở Explorer, Test writer, Healer và Popup resolver (phía server). Luật phụ thuộc cụ thể (D08): chỉ `packages/brain` được phụ thuộc LLM SDK; chỉ `apps/server` được phụ thuộc `@coral/brain`; app không import app khác. Kiểm tra tự động bằng ESLint + `pnpm check:boundaries` (kể cả phụ thuộc bắc cầu trong lockfile). |
| P2 | **Lưu cách tìm element, không lưu tọa độ làm chính** | Mỗi step có chuỗi locator dự phòng. Runner luôn đọc `bounds` thật lúc chạy rồi tap vào tâm. `point_pct` chỉ là phương án cuối. |
| P3 | **Không heal mù** | Healer phải phân loại `heal` / `bug` / `flaky` / `env`. Mọi thay đổi test case là một đề xuất (diff) cần người duyệt. Không được xóa hay nới lỏng assertion để test pass. |
| P4 | **Tri thức trung lập provider** | Memory và skills là file thuần (YAML/JSON/Markdown theo chuẩn `SKILL.md`, `AGENTS.md`), không phụ thuộc Claude, Gemini hay Copilot. |
| P5 | **Cô lập tenant từ ngày đầu** | Mọi bảng nghiệp vụ có `tenant_id` (ngoại lệ duy nhất: bảng định danh toàn cục `tenants`, `users`, `refresh_tokens` — D10). Mọi truy vấn, file, secret và ngữ cảnh AI đều lọc theo tenant/project. |
| P6 | **An toàn thao tác** | Có danh sách `never_tap` (phạm vi áp dụng: §9.4, D13). AI không được bấm hành động phá hủy hoặc tốn tiền. Agent không chạy lệnh phá hủy thiết bị (factory reset, xóa dữ liệu ngoài app đang test). |

---

## 3. Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| Tenant | Một tổ chức/khách hàng. Đơn vị cô lập dữ liệu. |
| Project | Nhóm app + test case của một sản phẩm. Mỗi project có một git repo riêng chứa tri thức. |
| App / Build | Ứng dụng (package Android / bundle id iOS) và từng bản build (apk/aab/ipa/app). |
| Agent | Daemon `coral-agent` cài trên máy có thiết bị, thuộc đúng một tenant. |
| Device | Thiết bị thật, emulator hoặc simulator do agent quản lý. |
| Lease | Quyền dùng độc quyền một thiết bị trong một khoảng thời gian (run, exploration, live session). |
| Test case | File YAML mô tả `intent` và các `steps`. |
| Step | Một hành động + `target` (chuỗi locator) + `expect`. |
| Locator | Một cách tìm element (id, text, vị trí tương đối, ảnh, tọa độ %). |
| Snapshot | Screenshot + cây element tại một step, dùng làm mốc so sánh. |
| Run | Một lần chạy một hoặc nhiều test case trên một thiết bị. |
| Proposal | Đề xuất thay đổi file trong repo project, chờ duyệt: heal test case (AI), `locator_refresh` (không AI), luật popup mới. |
| App map | Đồ thị màn hình và chuyển màn do Explorer xây dựng. |
| Skill | Chỉ dẫn riêng cho app (tài khoản test, màn hình cấm bấm, cách lấy OTP...). |
| Brain | Adapter tới một nhà cung cấp AI (Claude, Gemini, Copilot). |

---

## 4. Kiến trúc tổng quan

```
                 ┌──────────────┐          ┌────────────────────────────┐
  Browser ──────▶│  coral-web   │          │ Claude / Gemini / Copilot  │
                 └──────┬───────┘          └──────────────▲─────────────┘
                        │ HTTPS + WS(ui)                  │
┌───────────────────────▼─────────────────────────────────┴───────────────┐
│                        coral-server (control plane)                      │
│  API + Auth  │  Orchestrator: Explorer / Test writer / Healer / Popup    │
│              │  resolver + Brain router                                  │
│  Job queue + device lease  │  Storage: Postgres · Git repos · S3/MinIO   │
└───────────────────────▲─────────────────────────────────────────────────┘
                        │ WS(agent) — agent chủ động kết nối ra server
         ┌──────────────┼────────────────────┐
┌────────┴──────┐ ┌─────┴─────────┐ ┌────────┴────────────┐
│ coral-agent   │ │ coral-agent   │ │ (sau này) adapter   │
│ Linux/Windows │ │ macOS         │ │ device cloud        │
│ Android       │ │ iOS + Android │ └─────────────────────┘
└──────┬────────┘ └──────┬────────┘
   USB/emulator     USB/simulator
```

**Vì sao mô hình lai (server + agent):** thiết bị phải cắm vật lý hoặc chạy emulator trên máy thật, và iOS bắt buộc có macOS. Agent tự mở kết nối ra ngoài (giống GitHub self-hosted runner) nên chạy được sau NAT, không cần mở port, và user có thể dùng thiết bị của chính họ.

### 4.1 Bốn luồng chính

1. **Explore:** server điều khiển thiết bị từ xa qua agent (từng lệnh một) → Brain quyết định hành động → cập nhật app map → sinh trace.
2. **Write:** trace + intent → test case YAML (locator được trích tự động từ cây element, không do AI bịa) → chạy xác thực. Intent đến từ prompt của user, từ test case thủ công được import (§11.3), hoặc từ Recorder. Mọi test case được tạo và lưu **trong chính coral** (D31).
3. **Run:** server giao job → agent chạy **nguyên** test case cục bộ, không AI → gửi kết quả + artifact.
4. **Heal:** step lỗi → server gom failure bundle → Healer phân loại → đề xuất diff hoặc báo bug → người duyệt → commit vào git repo của project.

### 4.2 Gói trong monorepo và chiều phụ thuộc (D08, D09)

```
apps/server  ──▶ packages/brain ──▶ LLM SDK (chỉ ở đây)
     │
     ├──────────▶ packages/runner ◀── apps/agent, packages/cli
     └──────────▶ packages/shared ◀── mọi gói (kể cả apps/web)
```
- `packages/shared`: type + Zod schema dùng chung (test case, popups, WS message, fingerprint màn hình). Thuần, chạy được cả trên Node lẫn browser, không phụ thuộc gói nội bộ nào khác.
- `packages/runner` (tạo ở Phase 1): Runner tất định + popup guard lớp 2 + interface `DeviceDriver`. Dùng chung cho `apps/agent` và lệnh `coral run` cục bộ.
- `apps/web` không import `packages/brain` hay `packages/runner`.

---

## 5. Thành phần

### 5.1 coral-web
SPA giao diện người dùng. Các màn chính:

- Đăng nhập / đăng ký / quản lý thành viên tenant.
- Projects → Apps → Builds (upload build).
- Devices & Agents (tạo agent token, trạng thái thiết bị).
- **Live device:** xem màn hình trực tiếp, click để điều khiển, chế độ **Recorder**.
- Test cases: danh sách, editor YAML kèm ảnh từng step, trạng thái `draft/active/quarantined`.
- Runs: lịch sử, chi tiết từng step (screenshot, locator đã dùng, log, thời gian).
- **Heal review:** so sánh snapshot trước/sau, diff YAML, approve/reject.
- Explorations: chạy khám phá, xem app map.
- Popup rules, Skills, Bug list.
- Brain config & chi phí AI theo tenant.

### 5.2 coral-server
- **API + Auth:** REST + WebSocket. Auth tự quản: email + password (argon2id), JWT access token ngắn hạn + refresh token xoay vòng, API token cho CI. Vai trò: `owner`, `admin`, `member`, `viewer`. Web giữ access token trong bộ nhớ; refresh token nằm trong cookie `httpOnly; Secure; SameSite=Strict` giới hạn path `/auth` (D23).
- **Orchestrator:** Explorer (§10), Test writer (§11), Healer (§12), Popup resolver (§9.3). Mọi lời gọi AI đi qua Brain router (§14).
- **Job queue:** lịch chạy, hàng đợi, lease thiết bị độc quyền (một run một thiết bị), timeout, retry, hủy. Mọi hình thức dùng thiết bị (run, exploration, live session có điều khiển) đều phải giữ lease (D16).
- **Storage:**
  - Postgres: metadata (user, tenant, run, heal, chi phí...).
  - Git repo mỗi project: test cases, skills, popup rules, app map (có lịch sử, diff, review). Vị trí và cách đồng bộ: §13.1.
  - Object storage S3/MinIO: screenshot, cây element, video, log. Prefix theo tenant.

### 5.3 coral-agent
Daemon cài trên máy có thiết bị. Kết nối WebSocket ra server bằng agent token (thuộc một tenant, chỉ nhận job của tenant đó).

Nhiệm vụ:
- Báo danh sách thiết bị và khả năng (platform, OS, model).
- Chạy test case: **Runner** (§8) + **Popup guard lớp 2** (§9.2). Không AI.
- Thực thi lệnh từ xa cho Explorer, Recorder, Live view.
- Stream màn hình cho Live view.
- Upload artifact qua presigned URL.
- Cài build, cấp quyền, reset app, dọn dẹp sau mỗi run.

Driver nằm sau interface `DeviceDriver` (§8.1) (D27):
- **Android:** agent nói chuyện **trực tiếp** với server UiAutomator2 trên thiết bị — `u2.jar` của dự án `openatx/uiautomator2` (MIT), khởi chạy bằng `app_process`, gọi JSON-RPC 2.0 (`/jsonrpc/0`, cổng 9008) qua `adb forward`. **Không** qua Appium server: bớt một chặng mạng, không tốn thời gian tạo session, không cần cài APK test lên máy. Client JSON-RPC viết bằng TypeScript trong `packages/runner`; phiên bản `u2.jar` được ghim.
- **iOS:** Appium + XCUITest (WebDriverAgent), xem lại ở Phase 5.
- Dùng `adb` / `xcrun simctl` cho cài đặt, quyền, log, screenshot nhanh (`adb exec-out screencap`).

### 5.4 Brain layer (`packages/brain`)
Xem §14.

---

## 6. Mô hình dữ liệu (Postgres)

Mọi bảng nghiệp vụ có `tenant_id` và bật Row-Level Security (§17). Ngoại lệ: `tenants`, `users`, `refresh_tokens` là bảng định danh toàn cục, chỉ module auth được truy cập (D10). Kiểu `id` là UUID v7, **do ứng dụng sinh** (Postgres 17 chưa có `uuidv7()` sẵn, D11). Cột thời gian dùng `timestamptz`. Tên cột `snake_case` (D12).

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `tenants` | id, name, plan, settings (jsonb), created_at | `settings` chứa brain config (§14.3). |
| `users` | id, email (unique), password_hash, name, created_at | Không có tenant_id; liên kết qua memberships. |
| `memberships` | tenant_id, user_id, role | role ∈ owner/admin/member/viewer |
| `api_tokens` | id, tenant_id, user_id, name, token_hash, scopes, last_used_at | Cho CI. |
| `refresh_tokens` | id, user_id, token_hash, expires_at, revoked_at | Xoay vòng. |
| `projects` | id, tenant_id, name, git_repo_path | `git_repo_path` tương đối so với `CORAL_DATA_DIR` (§13.1). |
| `apps` | id, tenant_id, project_id, platform, package_or_bundle_id, name | |
| `builds` | id, tenant_id, app_id, version, artifact_key, checksum, uploaded_by | |
| `agents` | id, tenant_id, name, token_hash, os, capabilities (jsonb), last_seen_at, status | |
| `devices` | id, tenant_id, agent_id, platform, kind (real/emulator/simulator), model, os_version, udid, status | status ∈ idle/leased/offline. Unique (agent_id, udid). |
| `leases` | id, tenant_id, device_id, kind, holder_ref, acquired_at, expires_at, released_at | kind ∈ run/exploration/live. Tối đa một lease mở trên mỗi thiết bị (D16). |
| `test_cases` | id, tenant_id, project_id, slug, path_in_repo, intent, tags, status, head_commit, source, source_ref, validation (jsonb), draft_reason, flags, validated_at | status ∈ draft/active/quarantined. source ∈ manual/recorder/ai_explore/ai_prompt/ai_import. Là **chỉ mục** của file trong git; `status` chỉ lưu ở DB (D15, D31). Test case AI sinh: `validation` = 2 run xác thực, `draft_reason` ∈ validation_failed/changed_during_validation/needs_human/ambiguous/app_mismatch, `flags` ∈ needs_review_never_tap (D41). |
| `import_jobs` | id, tenant_id, project_id, app_id, build_id, device_id, source_format, file_name, mapping (jsonb), status, budget (jsonb), stats (jsonb), report (jsonb), manual_commit, created_by, created_at | Một lần import test case thủ công (§11.3). source_format ∈ csv/xlsx/gherkin; status ∈ preview/running/done/cancelled/failed. |
| `import_items` | id, tenant_id, import_job_id, n, manual_path, title, status, reason, evidence (jsonb), exploration_id, test_case_id, cost_usd | Một test case thủ công trong job. status ∈ pending/running/active/draft/not_processed; reason ∈ needs_human/ambiguous/app_mismatch/validation_failed/duplicate. Ghi ngay khi xong để job chạy tiếp sau khi server khởi động lại (D41). |
| `runs` | id, tenant_id, project_id, build_id, device_id, trigger, status, started_at, finished_at, validation_of? | trigger ∈ manual/schedule/ci/validation; `validation_of` = test case đang được xác thực (§11.2). |
| `run_items` | id, tenant_id, run_id, test_case_id, commit, status, failure_code | Một test case trong một run. |
| `run_steps` | id, tenant_id, run_item_id, step_id, status, locator_used_index, degraded, duration_ms, artifact_prefix | `degraded` = tìm thấy bằng locator ưu tiên thấp. |
| `explorations` | id, tenant_id, project_id, app_id, build_id, device_id, user_id, lease_id, kind, goal, budget (jsonb), max_tests, status, stop_reason, stats (jsonb), appmap_commit, import_item_id? | kind ∈ explore/prompt/import. status ∈ queued/running/writing/validating/done/stopped/failed/interrupted (D41). |
| `exploration_steps` | id, tenant_id, exploration_id, n, segment, fingerprint, screen_id, decision (jsonb), status, refusal, step (jsonb), flags, artifact_prefix, brain_call_id, cost_usd | Trace của Explorer (§10); ảnh và cây trên object storage, giữ 30 ngày. status ∈ done/refused/failed/popup/restart. |
| `findings` | id, tenant_id, project_id, exploration_id, step_n, kind, log_excerpt, artifact_prefix | Crash/ANR gặp khi khám phá (kind ∈ crashed/not_responding); ứng viên bug của Phase 4. |
| `heal_proposals` | id, tenant_id, project_id, kind, run_item_id?, test_case_id?, target_path, classification?, confidence, brain, reasoning, diff, verify_status, status, rejection_outcome?, reviewer_id, decided_at | kind ∈ locator_refresh/ai_heal/popup_rule. status ∈ pending/approved/rejected/superseded. rejection_outcome ∈ bug/wontfix (D17). |
| `bugs` | id, tenant_id, project_id, run_item_id, title, description, evidence_prefix, status | status ∈ open/confirmed/fixed/wontfix |
| `brain_calls` | id, tenant_id, role, provider, model, attempt, tokens_in, tokens_out, tokens_cached, cost_usd, latency_ms, ok, error, ref_type, ref_id, content_key | Theo dõi chi phí. Mỗi lần thử (dự phòng, hỏi lại) một dòng. `content_key`: nội dung đã che secret trên object storage, giữ 30 ngày (D41). |
| `tool_calls` | id, tenant_id, brain_call_id, mcp_server, tool, args_redacted, ok, blocked, error, latency_ms, created_at | Mọi lần Brain gọi tool MCP (§14.5, D29), kể cả lần bị chặn (`blocked`, error ∈ not_allowed/side_effects_disabled/timeout/server_error). |
| `secrets` | id, tenant_id, project_id?, name, ciphertext, created_by | `project_id` rỗng = secret cấp tenant (ví dụ API key của provider AI). Secret cấp project đè secret cấp tenant cùng tên. Mã hóa envelope (§17, D19). |
| `audit_log` | id, tenant_id, actor, action, target, meta, created_at | |

---

## 7. Định dạng test case (YAML)

Schema được định nghĩa bằng Zod trong `packages/shared` và có lệnh kiểm tra `coral validate`. File nằm ở `testcases/<slug>.yaml` trong git repo của project. Ví dụ đầy đủ: `examples/testcase.example.yaml`.

```yaml
schema: coral/testcase@1
id: login-to-profile
intent: "Đăng nhập bằng tài khoản test rồi mở trang Hồ sơ"
tags: [smoke, auth]
platforms: [android, ios]
preconditions:
  app_state: fresh              # fresh = xóa dữ liệu app trước khi chạy | keep
  grant_permissions: [notifications, location]
variables:
  username: ${secret:TEST_USER}      # tham chiếu secret theo tên, không lưu giá trị
  password: ${secret:TEST_PASSWORD}
steps:
  - id: s1
    action: tap
    target:
      - android_id: "com.example:id/btn_login"
      - ios_id: "loginButton"
      - text: "Đăng nhập"
      - rel: { below: { text: "Mật khẩu" }, class: Button }
      - image: snap/s1_target.png
      - point_pct: [0.50, 0.82]
    expect: { visible_text: "Hồ sơ", timeout_ms: 8000 }
    snapshot: snap/s1
```

### 7.1 Hành động (`action`)
Schema là một discriminated union theo `action` (D14). `expect` và `snapshot` là tùy chọn ở mọi hành động (riêng `assert` bắt buộc có `expect`).

| action | Tham số | `target` |
|---|---|---|
| `launch` | — (mở app đang test) | không |
| `tap` | — | bắt buộc |
| `long_press` | `ms` (mặc định 1000) | bắt buộc |
| `type` | `value` (bắt buộc), `clear_first` (mặc định false) | tùy chọn — không có thì gõ vào element đang focus |
| `clear` | — | bắt buộc |
| `swipe` | `direction` ∈ up/down/left/right + `distance_pct` (mặc định 0.6), **hoặc** `from` / `to` dạng `point_pct`; `ms` (mặc định 300) | tùy chọn — có thì vuốt trong vùng element |
| `scroll_to` | `direction` (mặc định down), `max_swipes` (mặc định 10) | bắt buộc (element cần tìm) |
| `back` | — | không |
| `hide_keyboard` | — | không |
| `wait` | `ms`, **hoặc** `until` (một `expect`) | không |
| `assert` | — (chỉ kiểm tra `expect`) | không |
| `open_deeplink` | `url` | không |

### 7.2 Locator (thứ tự trong `target` là thứ tự ưu tiên)

| Loại | Ý nghĩa | Nền tảng |
|---|---|---|
| `android_id` | `resource-id` | Android |
| `ios_id` | `accessibilityIdentifier` | iOS |
| `text` / `text_contains` | Text hiển thị (khớp đúng / chứa) | Cả hai |
| `desc` | `content-desc` (Android) / `label` (iOS) | Cả hai |
| `rel` | Vị trí tương đối: `below` / `above` / `left_of` / `right_of` một locator khác, có thể kèm `class` | Cả hai |
| `class_index` | `{ class, index, within? }` | Cả hai |
| `image` | So khớp ảnh cắt của element: `image: <đường dẫn .png trong repo project>` hoặc `{ path, threshold?: 0.5–1 (mặc định 0.85), screen_width? }` (bề rộng màn hình lúc cắt; ảnh được co theo bề rộng hiện tại). Template matching bằng OpenCV WASM trong runner (D27, D40); chỉ dùng trong `target`, không trong `expect` | Cả hai |
| `point_pct` | Tọa độ theo % kích thước cửa sổ. **Phương án cuối.** | Cả hai |

Locator gắn nền tảng (`android_id`, `ios_id`) bị bỏ qua khi chạy trên nền tảng kia.

**Khớp `class` (D14):** giá trị là tên đầy đủ của nền tảng (`android.widget.Button`, `XCUIElementTypeButton`) hoặc **tên ngắn** (`Button`). Tên ngắn khớp khi đoạn cuối sau dấu `.` (Android) hoặc phần sau tiền tố `XCUIElementType` (iOS) bằng đúng tên đó. Text so khớp sau khi chuẩn hóa khoảng trắng; phân biệt hoa/thường.

**Độ phủ nền tảng:** `coral validate` báo lỗi nếu một `target` (hoặc locator trong `expect`) không còn locator nào áp dụng được cho một nền tảng khai báo trong `platforms`.

### 7.3 Điều kiện kỳ vọng (`expect`)
`visible_text`, `visible` (một locator **hoặc** danh sách locator, khớp bất kỳ), `not_visible` (như `visible`), `screen` (id màn hình trong app map), `timeout_ms` (mặc định 5000). Có thể là một danh sách, tất cả phải đúng.

`visible_text` đúng khi có một node hiển thị trên màn hình mà `text` **chứa** giá trị (chuẩn hóa khoảng trắng, phân biệt hoa/thường; không xét content-desc — dùng `visible: { desc }`). Điều kiện `expect` xét mọi node hiển thị của cây, kể cả node đang bị popup che; kiểm tra "bị che" chỉ áp dụng cho target của thao tác (§8.4) — D35.

`screen` được kiểm tra bằng hàm fingerprint màn hình (§10) đặt trong `packages/shared`; khi test case dùng `screen`, `job.assign` gửi kèm fingerprint của các màn hình liên quan từ `appmap/screens.json` (D24).

### 7.4 Quy tắc
- `intent` là bắt buộc: Healer và Test writer dựa vào nó để hiểu mục đích, không chỉ dựa vào script.
- Không được lưu mật khẩu, token, OTP dạng rõ trong YAML. Luôn dùng `${secret:NAME}`.
- Biến khai báo trong `variables` được tham chiếu trong step bằng `${var:name}` (D14). Chỉ có hai dạng nội suy: `${secret:NAME}` và `${var:name}`.
- `snapshot` trỏ tới snapshot mốc (screenshot + cây element) trong repo, dùng cho Healer.

### 7.5 Quyền trừu tượng (`grant_permissions`)
Tên quyền trung lập nền tảng, được `packages/shared` ánh xạ sang permission Android và service của `simctl privacy`: `camera`, `microphone`, `location`, `location_always`, `notifications`, `contacts`, `photos`, `calendar`, `bluetooth`. Tên không có trong danh sách → `coral validate` báo lỗi.

---

## 8. Runner (không AI — `packages/runner`, chạy trong agent)

### 8.1 Interface driver
Driver tách làm hai phần (D28): **`UiDriver`** trung lập nền tảng — lõi runner (resolve locator, thao tác, `expect`, popup guard, chờ ổn định) **chỉ** dùng phần này; và **`TargetLifecycle`** — cài, reset, cấp quyền, log, khác nhau theo loại mục tiêu (thiết bị mobile hôm nay, trình duyệt nếu sau này mở rộng test web — §20 Q4).
```ts
type Platform = 'android' | 'ios'          // mở rộng thêm, không đổi nghĩa giá trị cũ (D28)

interface UiDriver {
  platform: Platform
  windowSize(): Promise<{ width: number; height: number }>   // đơn vị tap: px (Android), point (iOS)
  screenshot(): Promise<Buffer>                             // PNG, đơn vị pixel
  tree(): Promise<ElementNode[]>                            // cây element đã chuẩn hóa
  find(locator: Locator): Promise<ElementNode | null>
  tapAt(x: number, y: number): Promise<void>                // đơn vị tap của nền tảng
  longPressAt(x: number, y: number, ms: number): Promise<void>
  type(el: ElementNode, text: string): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  back(): Promise<void>
}

interface TargetLifecycle {
  launch(appId: string): Promise<void>
  install(buildPath: string): Promise<void>
  resetApp(appId: string): Promise<void>
  grantPermissions(appId: string, perms: string[]): Promise<void>
  deviceLogs(sinceMs: number): Promise<string>              // logcat / syslog
}

interface DeviceDriver extends UiDriver, TargetLifecycle {}
```
`ElementNode` chuẩn hóa hai nền tảng: `{ ref, platform_id, text, desc, class, bounds: {x,y,w,h}, clickable, enabled, visible, package_or_bundle, children }`.

Mỗi driver nằm trong thư mục riêng `packages/runner/src/drivers/<platform>/`; lõi runner không import gì từ đó hay từ `adb` / `u2.jar` / Appium (kiểm tra bằng ESLint, D28).

### 8.2 Thuật toán chạy một step
```
popupGuard.handle()                           # ngay sau launch / reset app (§9.2)
for step in testcase.steps:
    waitForStable()                           # §8.3
    el, idx = None, None
    if step.target:
        el, idx = resolve(step.target)        # thử locator theo thứ tự
        if el is None and popupGuard.handle():    # §9.2
            el, idx = resolve(step.target)
        if el is None: fail(step, TARGET_NOT_FOUND)
    perform(step.action, el)                  # tap vào tâm bounds THẬT lúc chạy
    ok = checkExpect(step.expect)             # không có expect → ok
    if not ok and popupGuard.handle():
        ok = checkExpect(step.expect)
    saveArtifacts(step, locator_used=idx, degraded = idx > firstApplicableIndex)
    if not ok: fail(step, EXPECT_FAILED)
```
Popup guard xử lý tối đa **3** popup cho mỗi step; vượt quá thì fail `BLOCKED_BY_POPUP` (D25).

### 8.3 Chờ ổn định
Không dùng `sleep` cố định. Lấy cây element hai lần cách nhau khoảng 300 ms; khi hash cấu trúc giống nhau thì coi là ổn định (tối đa `stable_timeout_ms`, mặc định 3000). Trên Android, tắt animation khi chuẩn bị thiết bị (`window_animation_scale`, `transition_animation_scale`, `animator_duration_scale` = 0).

### 8.4 Đơn vị tọa độ
- Android: bounds và tap đều tính bằng pixel.
- iOS: bounds và tap tính bằng **point**; screenshot tính bằng **pixel** (@2x, @3x). Mọi quy đổi screenshot → tap phải chia cho scale.
- `point_pct` nhân với `windowSize()` của nền tảng — tức cửa sổ app theo hướng xoay hiện tại, không phải toàn màn hình vật lý (D14). Test case mặc định giả định hướng dọc.
- Trước khi tap, kiểm tra element **nhận chạm** tại điểm tap có đúng là target (hoặc nằm trong / chứa target) không, tránh overlay trong suốt, bottom sheet, cửa sổ khác che. Element nhận chạm tính như Android phân phối sự kiện: trong cửa sổ trên cùng chứa điểm, node **bấm được** đầu tiên theo thứ tự vẽ từ trên xuống; node không bấm được (logo, nhãn trang trí) để chạm đi xuyên xuống; cửa sổ trên cùng luôn nhận chạm nếu trong nó không có gì bấm được. Dialog và popup (mọi cửa sổ phía trên trừ thanh hệ thống và bàn phím) là cửa sổ modal: nhận cả chạm ngoài khung của nó. Thứ tự cửa sổ lấy theo z-order của window manager (`dumpsys window windows`), không theo thứ tự trong dump u2 (D36).

### 8.5 Mã lỗi
`TARGET_NOT_FOUND`, `EXPECT_FAILED`, `APP_CRASHED`, `APP_NOT_RESPONDING`, `BLOCKED_BY_POPUP`, `TIMEOUT`, `DRIVER_ERROR`, `DEVICE_OFFLINE`.

### 8.6 Artifact mỗi step
Screenshot (PNG), cây element (JSON), locator đã dùng, thời gian, log thiết bị (khi lỗi), video toàn run (tùy chọn). Upload qua presigned URL vào `s3://<bucket>/<tenant_id>/runs/<run_id>/...`.

Giá trị secret đã giải mã **không bao giờ** xuất hiện trong log, `step.result` hay cây element JSON: agent thay mọi chuỗi trùng giá trị secret bằng `***` trước khi ghi/upload (D19).

### 8.7 Self-heal nhẹ không cần AI
Nếu step pass nhưng `degraded = true` (ví dụ id không còn khớp, phải dùng text), runner đánh dấu step. Server tạo proposal `kind = locator_refresh`: sinh lại chuỗi locator từ element vừa tìm thấy, không gọi AI, vẫn cần người duyệt.

---

## 9. Xử lý popup (3 lớp)

### 9.1 Lớp 1 — Chặn trước
- Android: cài bằng `adb install -g` hoặc `pm grant`.
- iOS simulator: `xcrun simctl privacy <udid> grant <service> <bundleId>`. Quyền thông báo và mọi quyền trên máy thật không cấp trước được, nên để lớp 2 xử lý.
- Chuẩn bị thiết bị: tắt autofill / lưu mật khẩu, tắt cập nhật tự động, cố định ngôn ngữ.
- Nếu kiểm soát được source app: launch argument / cờ "test mode" tắt onboarding, xin đánh giá, quảng cáo, in-app update.
- Test chính luồng xin quyền thì chạy riêng, **không** cấp trước.

### 9.2 Lớp 2 — Popup guard (agent, không AI)
Chạy khi: vừa mở app; không tìm thấy target; `expect` thất bại (popup hay hiện trễ).

Nhận diện:
- Android: có element thuộc package khác app (ví dụ `permissioncontroller`) hoặc dialog đè lên.
- iOS: có `XCUIElementTypeAlert`. Alert hệ thống nằm ở Springboard, phải query thêm `com.apple.springboard`.

So khớp với `popups.yaml` → bấm nút tương ứng → chạy lại bước. **Ngoại lệ:** nếu target hoặc `expect` của step hiện tại nằm trong popup, tức là đang test chính popup đó, thì không đóng.

Toast / snackbar không chặn thao tác, bỏ qua.

```yaml
schema: coral/popups@1
rules:
  - name: android_permission
    match: { package: "com.android.permissioncontroller" }
    tap_any: ["Khi dùng ứng dụng", "Cho phép", "While using the app", "Allow"]
  - name: ios_notification
    match: { alert_contains: "Notifications" }
    tap_any: ["Allow", "Cho phép"]
  - name: rate_app
    match: { text_contains: "Đánh giá" }
    tap_any: ["Để sau", "Không, cảm ơn", "Not now"]
never_tap: ["Mua", "Thanh toán", "Xóa", "Đăng xuất", "Buy", "Pay", "Delete"]
```

Mọi khóa trong `match` phải cùng đúng. So khớp text không phân biệt hoa/thường, đã chuẩn hóa khoảng trắng. Ví dụ đầy đủ: `examples/popups.example.yaml`.

### 9.3 Lớp 3 — Popup resolver (server, có AI)
Khi guard không khớp luật nào mà target vẫn không thấy: agent gửi snapshot lên server → Brain trả lời "có popup chặn không, nút nào đóng an toàn" (chỉ được chọn nút trung tính, không được chọn nút trong `never_tap`) → agent thử → nếu thành công, server tạo proposal `kind = popup_rule` cho `popups.yaml`, chờ người duyệt. Lần sau gặp lại popup đó thì không cần AI.

### 9.4 Phạm vi `never_tap` (D13)
`never_tap` là danh sách text/desc (không phân biệt hoa/thường, khớp nguyên chuỗi sau chuẩn hóa khoảng trắng). Áp dụng cho **mọi hành động do máy tự quyết**:
- Popup guard lớp 2: không bấm nút thuộc `never_tap` dù luật có ghi.
- Popup resolver lớp 3, Explorer: loại element thuộc `never_tap` khỏi lựa chọn và kiểm tra lại quyết định của Brain.
- Healer: patch không được thêm thao tác bấm vào element thuộc `never_tap` (luật review §12.2).
- Test writer: bản nháp có step bấm element thuộc `never_tap` bị giữ ở `draft` và gắn cờ cần duyệt riêng.

**Không** áp dụng cho step trong test case đã được người duyệt (ví dụ test chức năng "Xóa" hoặc "Đăng xuất" là hợp lệ).

---

## 10. Explorer (server + agent, có AI)

**Đầu vào:** build, thiết bị, mục tiêu (tùy chọn, ví dụ "khám phá toàn bộ" hoặc một intent cụ thể), ngân sách `{ max_steps, max_depth, max_minutes, max_cost_usd }`, skills của project.

**Vòng lặp:**
1. Quan sát: cây element + screenshot.
2. Tính **fingerprint màn hình**: hash của (activity / view controller nếu có) + tập hợp đã sắp xếp các cặp `(class, platform_id)` của element cấu trúc, bỏ qua text và phần tử lặp trong list. Hàm này nằm trong `packages/shared` để runner dùng lại cho `expect.screen` (D24).
3. Cập nhật **app map** (màn hình, chuyển màn).
4. Tuần tự hóa element hành động được thành danh sách **đánh số** (`#1`, `#2`...) kèm id, text, desc, class, bounds.
5. `brain.nextAction(...)` → trả về hành động theo **số element**.
6. Kiểm tra an toàn: `never_tap` (§9.4), luật trong skills.
7. Thực thi qua agent, ghi **trace** (hành động + snapshot element đã chọn).

**Chiến lược:** ưu tiên element/màn hình chưa đi qua (frontier); dùng back để quay lui; khởi động lại app khi kẹt. Dừng khi hết ngân sách.

**App map** (`appmap/screens.json`):
```json
{
  "screens": [{ "id": "login", "name": "Đăng nhập", "fingerprint": "…", "snapshot": "appmap/snap/login" }],
  "transitions": [{ "from": "login", "to": "home", "action": { "tap": { "android_id": "…" } } }]
}
```
`name` của màn hình mới do `brain.describeScreen` đặt.

---

## 11. Test writer & Recorder

### 11.1 Recorder (không AI)
Từ một element được chọn (theo số `#12`, hoặc click trên live view → hit-test: element nhỏ nhất chứa điểm click và clickable), recorder **tự trích toàn bộ locator** theo thứ tự ưu tiên ở §7.2, cắt ảnh element, lưu snapshot. AI không bao giờ tự bịa locator.

### 11.2 Test writer (có AI)
Nhận trace từ Explorer hoặc Recorder → chia thành các flow có ý nghĩa → viết `intent`, đặt tên, thêm `expect` hợp lý → xuất YAML hợp lệ theo schema. Brain chỉ tham chiếu **bước trong trace**; locator được hệ thống điền từ snapshot của bước đó, không lấy từ output của Brain.

**Xác thực:** test case mới chạy tất định 2 lần liên tiếp. Pass cả 2 thì `active`, ngược lại để `draft`.

### 11.3 Tạo test case từ prompt hoặc từ test case có sẵn (D31)
Test case chỉ được tạo trong coral, từ bốn nguồn: viết tay (API/editor), Recorder (§11.1), **prompt** của user, và **import** test case thủ công đã có.

- **Prompt:** user mô tả mục tiêu ("đăng nhập rồi đổi ảnh đại diện") → Explorer chạy chế độ có mục tiêu (§10) → Test writer viết YAML.
- **Import:** user tải lên nhiều test case thủ công (title, tiền điều kiện, các bước + kết quả mong đợi).
  1. **Đọc file — không AI:** CSV / Excel (có bước ghép cột) và Gherkin `.feature` được chuyển thành định dạng trung lập `coral/manualcase@1`, lưu trong repo project ở `imports/<job_id>/` (file thuần, P4). Định dạng export của TestRail / Zephyr / Xray thêm sau qua adapter.
  2. **Khám phá có hướng dẫn — có AI:** với mỗi test case thủ công, Explorer lấy các bước làm mục tiêu, tự tìm element trên app thật và ghi trace (không bấm `never_tap`, trong ngân sách).
  3. **Viết test:** Test writer tạo YAML: `intent` từ title + mô tả; `expect` từ kết quả mong đợi; locator trích từ snapshot (P2); `source = ai_import`, `source_ref` trỏ về test case gốc.
  4. **Xác thực** như §11.2. Không thành công thì giữ `draft` kèm lý do: `needs_human` (OTP, thao tác vật lý…), `ambiguous` (bước mô tả mơ hồ), `app_mismatch` (app không làm như mô tả — có thể là **bug** hoặc test case cũ; không được sửa kỳ vọng cho khớp app, P3).
- Import chạy thành job nền (`import_jobs`) có ngân sách chi phí, tiến độ và báo cáo cuối (đã tạo / cần người / nghi bug).

---

## 12. Healer (server, có AI)

### 12.1 Failure bundle
Test case, step lỗi, mã lỗi, snapshot mốc, snapshot hiện tại (screenshot + cây), diff cây element, log thiết bị (đoạn cuối logcat/syslog), lịch sử heal gần đây của test case.

### 12.2 Pipeline (theo mô hình Remedy)
1. **Phân loại tất định** (không AI):
   - Crash / ANR trong log → `bug` (`APP_CRASHED` / `APP_NOT_RESPONDING`).
   - Lỗi driver / thiết bị → `env`, retry 1 lần.
   - Target tìm thấy bằng locator ưu tiên thấp → `locator_refresh` (§8.7).
   - Bị chặn bởi popup lạ → Popup resolver (§9.3).
2. **Chẩn đoán bằng Brain** → JSON:
   ```json
   { "classification": "heal|bug|flaky|env", "confidence": 0.0, "reasoning": "…", "patch": { "…": "…" } }
   ```
3. **Verify:** áp patch tạm, chạy lại trên thiết bị từ step lỗi (hoặc cả test case).
4. **Review:** kiểm tra theo luật — patch không được xóa hay nới lỏng `expect`, không được đổi `intent`, không được bỏ bớt nhiều step, không chạm `never_tap`. Có thể thêm một Brain thứ hai review. Tối đa 2 vòng sửa ↔ review.
5. **Người duyệt** trên web UI → approve thì commit vào git repo của project (commit message ghi run id, brain, confidence) → ghi heal log. Reject thì ghi `rejection_outcome` = `bug` (tạo bản ghi `bugs`) hoặc `wontfix` (D17). Proposal cũ của cùng test case/step bị thay bằng proposal mới thì chuyển `superseded`.

### 12.3 Chỉ số
Tỷ lệ heal đúng, **tỷ lệ heal sai** (sửa test làm che bug), thời gian chẩn đoán, chi phí mỗi lần heal.

---

## 13. Memory & skills (git repo mỗi project)

```
<project-repo>/
├── AGENTS.md              # luật chung cho mọi brain (ngôn ngữ app, quy ước, cảnh báo)
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md            # chuẩn Agent Skills: name + description + nội dung
│       └── rules.yaml          # coral/skill-rules@1: never_tap, forbidden, test_data, allow_submit (máy đọc — D42)
├── testcases/*.yaml
├── snap/                  # snapshot mốc của test case
├── popups.yaml
├── mcp.yaml               # MCP server + tool được phép cho các vai trò AI (§14.5)
├── appmap/
│   ├── screens.json        # coral/appmap@1
│   └── snap/
└── imports/<job_id>/*.yaml # coral/manualcase@1 — test case thủ công đã import (§11.3)
```

- Prompt builder chỉ nạp `AGENTS.md` + skill có `description` khớp nhiệm vụ (progressive disclosure), và **chỉ** từ repo của project đang chạy.
- Heal log lưu ở DB (`heal_proposals`) + lịch sử commit.
- Secret không bao giờ nằm trong repo, chỉ tham chiếu theo tên.

### 13.1 Lưu trữ và đồng bộ (D15)
- Repo là bare git repo trên volume bền của server: `${CORAL_DATA_DIR}/repos/<tenant_id>/<project_id>.git`, truy cập qua interface `ProjectRepoStore` (để sau này thay bằng Gitea/GitHub).
- Git là nguồn sự thật cho **nội dung** file; bảng `test_cases` là chỉ mục, cập nhật mỗi khi server commit. Trạng thái `draft/active/quarantined` chỉ ở DB, không ghi vào YAML (tránh commit rác).
- Phase 1–4: mọi thay đổi đi qua API của server; không hỗ trợ push trực tiếp vào repo. Đồng bộ từ remote bên ngoài để sau.

---

## 14. Brain layer (`packages/brain`)

### 14.1 Interface
```ts
interface Brain {
  id: string                                   // "claude", "gemini", "copilot"
  describeScreen(i: ScreenInput): Promise<ScreenSummary>
  nextAction(i: DecideInput): Promise<ActionDecision>
  writeTest(i: WriteTestInput): Promise<TestCaseDraft>
  diagnose(i: DiagnoseInput): Promise<Diagnosis>
  resolvePopup(i: ScreenInput): Promise<PopupDecision>
}
```
- `ScreenInput` gồm: nền tảng, kích thước cửa sổ, screenshot (đã resize), **danh sách element đánh số**.
- Hành động do Brain trả về tham chiếu **số element** (`{ "tap": "#12" }`). Chỉ dùng `point_pct` khi không có element phù hợp (Flutter không Semantics, canvas, game).
- Mọi output được validate bằng Zod. JSON sai thì gửi lại kèm thông báo lỗi, tối đa 2 lần, sau đó báo thất bại.

### 14.2 Adapters
| Adapter | SDK | Ghi chú |
|---|---|---|
| `claude` | `@anthropic-ai/sdk` | Tọa độ (nếu có) là pixel theo ảnh đã gửi → adapter quy đổi sang `point_pct`. |
| `gemini` | `@google/genai` | Bounding box chuẩn hóa thang 0–1000 → adapter quy đổi sang `point_pct`. |
| `copilot` | `@github/copilot-sdk` | Agent runtime của Copilot (runtime CLI đi kèm SDK theo nền tảng, không cài riêng). Nhận ảnh (attachment base64) nên dùng được cho mọi vai trò. Adapter tắt toàn bộ công cụ có sẵn của Copilot (shell, sửa file), chạy trong thư mục tạm rỗng; AI chỉ thấy công cụ của coral (MCP allowlist, `read_skill`). Cần subscription Copilot; mỗi lời gọi tính một premium request. Không dùng proxy không chính thức. Bật bằng `CORAL_COPILOT_ENABLED=1` **và** `providers.copilot.enabled: true`; token của tenant (`token_secret`) hoặc của nền tảng (`CORAL_COPILOT_TOKEN`). Làm cùng Claude và Gemini trong US1 (D20, D47, R7). |

### 14.3 Định tuyến theo vai trò (`brains.yaml`, theo tenant)
```yaml
roles:
  explorer: { provider: gemini, model: "<flash-class>" }   # gọi nhiều, cần rẻ + vision
  writer:   { provider: copilot }
  healer:   { provider: claude, model: "<reasoning-class>" }
  popup:    { provider: gemini, model: "<flash-class>" }
fallback: [claude, gemini]
limits:
  max_cost_usd_per_day: 20
  max_cost_usd_per_exploration: 3
```
Đây là cấu hình khởi đầu, sẽ được điều chỉnh theo kết quả benchmark (§14.4). Tên model không hard-code trong code.

Thêm từ Phase 3 (D43): `providers.<id>` (model mặc định khi dự phòng, `api_key_secret` = tên secret của key riêng tenant); `limits.max_cost_usd_per_import`; `prices:` (USD / 1 triệu token theo model, ghi đè bảng đơn giá của nền tảng `apps/server/ai-prices.yaml`; model tính tiền theo lời gọi như Copilot dùng thêm `per_request`, USD mỗi lời gọi — D47). Model không có đơn giá thì không được gọi. Provider `fake` / `fake-alt` (adapter có kịch bản, không mạng) chỉ nhận khi server chạy với `CORAL_BRAIN_FAKE=1` (test, CI).

**Lưu trữ (D20):** cấu hình lưu ở `tenants.settings` (jsonb), validate bằng cùng Zod schema với `brains.yaml`; `GET/PUT /brains/config` nhận/trả YAML hoặc JSON. API key của provider là secret cấp tenant (BYOK); server có thể có key mặc định của nền tảng qua biến môi trường. Ví dụ: `examples/brains.example.yaml`.

### 14.4 Benchmark
Bộ "đề thi" cố định (10–20 flow trên app mẫu + app fixture có biến thể UI). Chạy từng brain, đo: tỷ lệ pass, chi phí mỗi lần chạy, thời gian, tỷ lệ heal sai. Mọi lời gọi ghi vào `brain_calls`.

### 14.5 Công cụ qua MCP (D29)
coral là **MCP client** ở phía server: các vai trò AI (Explorer, Test writer, Healer, Popup resolver) được gọi tool từ các MCP server khai báo cho project.

- **Khai báo:** `mcp.yaml` trong repo project (§13) — tên server, địa chỉ, danh sách tool được phép; credential chỉ tham chiếu `${secret:NAME}`. File thuần, không gắn provider (P4).
- **Trung lập provider:** Brain router tự làm MCP client (`@modelcontextprotocol/sdk`) và chuyển tool MCP thành function calling của từng adapter (Claude, Gemini, Copilot) — không dựa vào tính năng MCP riêng của từng nhà cung cấp.
- **Vòng gọi tool:** trong một quyết định, Brain có thể yêu cầu gọi tool; router thực thi, đưa kết quả lại, tối đa 5 lượt rồi Brain phải trả quyết định cuối (vẫn validate bằng Zod như §14.1).
- **Ví dụ dùng:** Explorer web điều khiển trình duyệt qua Playwright MCP (Phase 7, §20 Q4); lấy OTP hoặc tạo dữ liệu test qua MCP server do user cung cấp (R4); tạo issue cho bug đã được người xác nhận.
- **Ràng buộc:**
  - P1: runner và agent khi **chạy lại** test không gọi MCP; test case đã lưu không phụ thuộc MCP. MCP SDK chỉ được dùng ở phía server (bổ sung vào kiểm tra D08 khi bắt đầu dùng ở Phase 3).
  - P5: cấu hình và credential theo tenant/project; phiên AI chỉ thấy MCP server của project đang chạy.
  - P6: mỗi server có allowlist tool; tool có tác dụng phụ (ghi, xóa, gửi, trả tiền) mặc định tắt, bật từng tool; mọi lần gọi ghi vào `tool_calls` với tham số đã che secret.
  - An ninh multi-tenant: tenant chỉ khai báo MCP server **từ xa** (HTTP). MCP server chạy tiến trình cục bộ (stdio) chỉ được phép từ danh sách do nền tảng duyệt sẵn (ví dụ Playwright MCP), hoặc chạy trên agent của chính tenant.

**coral làm MCP server (D32, Phase 6).** AI bên ngoài (Claude Code, Copilot, Cursor…) kết nối tới `/mcp` của coral bằng API token (§5.2):
- **Tool của coral:** `list_testcases`, `create_testcase_from_prompt`, `import_testcases`, `run_testcases`, `get_run`, `get_step_artifacts`, `list_proposals`, `list_bugs`. **Không** có tool approve/reject proposal (P3: người duyệt trên web).
- **Cổng MCP (gateway):** cùng kết nối đó, AI bên ngoài gọi được tool từ các MCP server user tự cấu hình trong `mcp.yaml` của project — chỉ những tool được đánh dấu `expose: true`, vẫn qua allowlist, luật tác dụng phụ và log `tool_calls` (ghi actor là API token).
- **Quyền:** API token có scope `mcp:read`, `mcp:run`, `mcp:tools`; chỉ thấy project của tenant sở hữu token (P5).

---

## 15. Giao thức agent ↔ server (WebSocket, JSON)

Mỗi message có `{ v: 1, type, id, ts, payload }` và trường tùy chọn `re` (D18):
- `id`: UUID v7 của message. `ts`: Unix epoch **milliseconds**.
- `re`: `id` của message mà message này trả lời (bắt buộc với `job.ack`/`job.reject`, `artifact.upload_url`, `device.command_result`, `popup.decision`).
- Agent xác thực bằng header `Authorization: Bearer <agent token>` khi mở kết nối `WS /ws/agent`.
- Heartbeat 15 giây; mất 3 heartbeat thì đánh dấu offline. Agent offline khi đang giữ lease → `run_item` đang chạy fail `DEVICE_OFFLINE`, lease được giải phóng, không tự retry (Phase 1).
- Payload chứa dữ liệu nhị phân lớn (`stream.frame`) gửi bằng **binary WS frame** thay vì base64 trong JSON (Phase 2): `[uint32 BE độ dài header][header JSON { type, udid, seq, ts, width, height, device_width, device_height, rotation, mime }][ảnh JPEG/PNG]`, tối đa 2 MB/khung. Server chuyển nguyên khung tới trình duyệt qua `/ws/ui` (header thêm `device_id`).

| Hướng | type | Nội dung |
|---|---|---|
| A→S | `agent.hello` | phiên bản, OS, capabilities, danh sách thiết bị |
| A→S | `device.update` | thiết bị thêm / bớt / đổi trạng thái |
| S→A | `job.assign` | run id, thiết bị, build, test cases (YAML + commit), popups.yaml, giá trị secret đã giải mã mà test case tham chiếu, fingerprint màn hình khi có `expect.screen` (`items[].screens: { <screen_id>: <fingerprint> }` lấy từ app map tại commit của item — Phase 3); mỗi test case kèm `assets: [{ path, sha256, download_url }]` — ảnh của locator `image`, lưu theo nội dung `<tenant>/assets/<sha256>`, agent cache theo sha256, sai sha → item `error` (Phase 2) |
| A→S | `job.ack` / `job.reject` | |
| A→S | `step.result` | kết quả từng step, locator đã dùng, degraded |
| A→S | `artifact.request_upload` | xin presigned URL |
| S→A | `artifact.upload_url` | presigned URL |
| A→S | `job.done` | tổng kết, mã lỗi (nếu có) |
| A→S | `popup.unknown` | snapshot để server gọi Popup resolver |
| S→A | `popup.decision` | nút cần bấm hoặc "không xử lý được" |
| S→A | `device.command` | `{ command_id, udid, command }`: lệnh đơn khi điều khiển (`tap`, `long_press`, `swipe`, `type`, `back`, `home`, `hide_keyboard`, `restart_app`) và của Recorder (`prepare`, `record`, `inspect` — chọn element, chuỗi locator, snapshot tải lên presigned URL), của Explorer (`observe` — chờ ổn định, popup guard, ảnh `screen.jpg` + `ai.jpg` ≤ 1024 px + `tree.json` tải lên, trả cây, activity, app còn chạy, crash — D44); lệnh chạy lần lượt theo thiết bị, không khi thiết bị đang chạy run |
| A→S | `device.command_result` | `{ command_id, ok, error?: { code, message }, result? }` (`re` bắt buộc) |
| S→A | `stream.start` / `stream.stop` | bật / tắt live view (`fps` 2–5, `max_edge`, `quality`) |
| A→S | `stream.frame` | khung hình JPEG/PNG, binary frame (xem trên) |
| S→A | `job.cancel` | hủy run |
| S→A | `agent.welcome` | trả lời `agent.hello`: `agent_id`, chu kỳ heartbeat (D33) |
| A→S | `agent.heartbeat` | mỗi 15 giây, kèm trạng thái thiết bị; gia hạn lease (D33) |
| A→S | `item.result` | kết quả từng test case trong run, gửi ngay khi xong (D33) |
| ↔ | `error` | message không hợp lệ / lỗi xử lý, có `re` nếu đọc được `id` (D33) |

---

## 16. REST API (phác thảo)

JSON dùng tên trường `snake_case` như trong SPEC (D12).

```
GET    /health                     (không cần auth)
GET    /health/ready               (không cần auth; 200 khi Postgres, Redis, S3, thư mục dữ liệu dùng được, 503 nếu không)
POST   /auth/register | /auth/login | /auth/refresh | /auth/logout
GET    /me
GET    /tenants/:id/members        POST /tenants/:id/invites
GET    /projects                   POST /projects
GET    /projects/:id/apps          POST /projects/:id/apps
POST   /apps/:id/builds            (upload)
GET    /agents                     POST /agents   (trả token một lần)
POST   /agents/:id/revoke          (thu hồi token, đóng kết nối WS của agent)
GET    /devices                    (kèm `activity`: idle / run / live / recording / offline)
POST   /devices/:id/control        DELETE /devices/:id/control   GET /devices/:id/control   (phiên điều khiển, lease `live`)
POST   /recordings                 GET  /recordings   GET /recordings/:id   PATCH /recordings/:id   DELETE /recordings/:id
POST   /recordings/:id/stop | /resume | /save   GET /recordings/:id/yaml   (Recorder, lease `recording`; save = một commit gồm YAML + snap/<slug>/)
GET    /projects/:id/testcases     POST /projects/:id/testcases
POST   /projects/:id/imports   (tải file → xem trước)   PATCH /imports/:id   POST /imports/:id/start | /cancel   GET /imports   GET /imports/:id   DELETE /imports/:id   (§11.3)
GET    /testcases/:id              PUT  /testcases/:id
GET    /testcases/:id/history      (các commit đã sửa test case, mới nhất trước — D31)
GET    /testcases/:id/snapshots    GET /testcases/:id/files/*path   (chỉ trong snap/<slug>/)   GET /testcases/:id/last-run-steps   (ảnh cho editor)
POST   /runs                       GET  /runs   GET /runs/:id   POST /runs/:id/cancel
GET    /runs/:id/items/:itemId/steps
POST   /explorations   (có `goal` = tạo test case từ prompt, §11.3)   GET /explorations   GET /explorations/:id   GET /explorations/:id/steps   POST /explorations/:id/stop
GET    /projects/:id/appmap        GET  /projects/:id/files/*path   (chỉ appmap/snap/, imports/)
PATCH  /testcases/:id              (status draft/active/quarantined)
GET    /heals                      POST /heals/:id/approve   POST /heals/:id/reject
GET    /projects/:id/popups        PUT  /projects/:id/popups
GET    /projects/:id/agents-md     PUT  /projects/:id/agents-md
GET    /projects/:id/skills        GET|PUT|DELETE /projects/:id/skills/:name   (SKILL.md + rules.yaml)
GET    /brains/config              PUT  /brains/config
GET    /projects/:id/mcp           PUT  /projects/:id/mcp   (mcp.yaml, §14.5)
GET    /usage/ai                   GET  /brain-calls/:id   (nội dung lời gọi AI, 30 ngày)
WS     /ws/ui      (sự kiện run, live view, lệnh điều khiển/ghi; xác thực trong băng: message đầu `ui.auth { access_token }` — D38)
WS     /ws/agent   (§15)
POST   /mcp        (coral làm MCP server, Streamable HTTP — §14.5, D32)
```

---

## 17. Bảo mật & multi-tenant

- **Không** chạy một process thường trực cho mỗi user. API server dùng chung, không giữ state nghiệp vụ trong bộ nhớ. Cô lập ở cấp **run**: mỗi run là một job riêng giữ độc quyền một thiết bị; chạy xong gỡ app / xóa dữ liệu rồi trả thiết bị.
- **Giới hạn hiện tại (R10):** kết nối WS của agent và git repo project nằm trên một instance server. Đến khi cần nhiều instance: định tuyến message agent qua Redis pub/sub và chuyển repo sang git server riêng.
- **Dữ liệu:** mọi bảng nghiệp vụ có `tenant_id`; bật Postgres Row-Level Security; mỗi request set `app.tenant_id` trong transaction; truy cập DB chỉ qua repository có tenant scope. Server kết nối DB bằng role **không** phải owner của bảng để RLS có hiệu lực.
- **File:** prefix riêng mỗi tenant trên object storage; presigned URL ngắn hạn.
- **Secret:** mã hóa envelope (data key mỗi tenant, master key trong biến môi trường / KMS). Chỉ giải mã khi cần cấp cho job; agent che giá trị secret trong mọi log/artifact dạng text (§8.6). Trước khi có bảng `secrets` (Phase 5), server và `coral run` đọc secret từ biến môi trường `CORAL_SECRET_<NAME>` — **chỉ dùng cho dev** (D19).
- **Ngữ cảnh AI:** prompt builder chỉ lấy dữ liệu từ project đang chạy. Không bao giờ trộn dữ liệu tenant khác vào prompt.
- **Agent:** token thuộc một tenant, chỉ nhận job của tenant đó; có thể thu hồi.
- **Auth:** argon2id, JWT ngắn hạn, refresh xoay vòng (cookie httpOnly, D23), rate limit đăng nhập, audit log cho hành động quan trọng (approve heal, tạo agent, đổi brain config).

---

## 18. Quan sát & chi phí

- Log có cấu trúc (JSON, pino), gắn `tenant_id`, `run_id`, `step_id`.
- Timeline mỗi run (hàng đợi → chuẩn bị → từng step → dọn dẹp).
- Chi phí AI theo tenant / vai trò / ngày; chặn khi vượt `limits`.
- Giữ artifact 30 ngày (cấu hình được, bằng lifecycle rule của bucket); snapshot mốc trong git giữ vĩnh viễn.

---

## 19. Tech stack (đã chốt ở Phase 0 — D07)

| Phần | Chốt | Lý do / ghi chú |
|---|---|---|
| Ngôn ngữ | TypeScript 6.0 strict toàn bộ (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`) | Một ngôn ngữ cho server, web, agent; SDK Claude, Gemini, Copilot đều có bản TS. TS 7 (bản native) chờ typescript-eslint hỗ trợ. |
| Runtime | Node.js 24 LTS, chỉ ESM | LTS hiện hành; `fetch`, `WebSocket`, `--env-file` có sẵn. |
| Monorepo | pnpm workspaces (pnpm 10, ghim qua `packageManager`) + Turborepo 2 | Gói nội bộ xuất thẳng source TS (không build riêng); app được bundle khi build. |
| Build | `tsdown` cho server/agent/cli, Vite cho web; `tsx` khi dev | Bundle kèm gói nội bộ → artifact chạy bằng `node` thuần. |
| Server | Fastify 5, `@fastify/websocket`, Zod 4, pino | Nhẹ, nhanh, schema-first; pino là logger JSON sẵn của Fastify. |
| Auth | `@node-rs/argon2` (argon2id), `jose` (JWT) | Binary dựng sẵn, không cần node-gyp. |
| DB | PostgreSQL 17, Drizzle ORM + drizzle-kit, driver `pg`; UUID v7 bằng gói `uuidv7` | RLS, migration rõ ràng. |
| Queue | Redis 7 + BullMQ 5 | Tương thích Valkey nếu cần đổi. |
| Object storage | MinIO (dev) / S3 (prod) qua `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | Chỉ dùng S3 API chuẩn để thay được MinIO (R8). |
| Git | `simple-git` (bọc `git` CLI) | |
| YAML | `yaml` (eemeli) | Giữ comment và format khi sửa → diff heal sạch. |
| Web | React 19 + Vite 8 + TanStack Query; TanStack Router + Tailwind CSS từ Phase 2 | SPA đơn giản; server tách riêng. |
| Agent — Android | Client TS gọi thẳng server UiAutomator2 `u2.jar` (openatx/uiautomator2, JSON-RPC qua `adb forward`); `adb` cho cài đặt, quyền, log | Nhanh hơn và ít thành phần hơn Appium; không cài APK test (D27). |
| Agent — iOS | WebdriverIO (chế độ remote) → Appium 3 XCUITest (WebDriverAgent); `xcrun simctl` | Appium lo build/ký WDA; xem lại ở Phase 5. |
| So khớp ảnh | OpenCV WASM (`@techstark/opencv-js`) trong `packages/runner` | Không còn Appium images plugin trên Android (D27). |
| Live view | MVP: stream JPEG qua WS (2–5 fps). Sau: scrcpy (Android), MJPEG của WebDriverAgent (iOS) | Làm nhanh trước, tối ưu sau. |
| CLI | `commander`, binary `coral` | |
| Test | Vitest 5 (projects cho cả monorepo); test cần thiết bị đặt trong `*.device.test.ts` (D21), test cần Postgres/Redis/MinIO đặt trong `*.int.test.ts` (D34) — cả hai bị bỏ qua mặc định | |
| Lint / format | ESLint 10 flat config + typescript-eslint (type-aware), Prettier 3 | `no-floating-promises` quan trọng với code thiết bị bất đồng bộ. |
| Ranh giới phụ thuộc | ESLint `no-restricted-imports` + `scripts/check-boundaries.mjs` (manifest + lockfile bắc cầu) | Thực thi P1 (D08). |
| Dev infra | Docker Compose: postgres 17, redis 7, minio (image `pgsty/minio` — D26), đều có healthcheck | |
| CI | GitHub Actions: format, lint, boundaries, typecheck, test, build + job dựng docker compose | |
| Quy trình spec | GitHub Spec Kit v1.0.12 (`.specify/`, skill `/speckit-*` trong `.claude/skills/`) | Mỗi phase là một feature trong `specs/` (D22). |

---

## 20. Rủi ro & câu hỏi mở

| # | Rủi ro / câu hỏi | Hướng xử lý |
|---|---|---|
| R1 | Healer phân loại sai, che bug | Luật cứng ở §12.2, luôn cần người duyệt, đo tỷ lệ heal sai. |
| R2 | iOS: cần Mac, ký app cho máy thật | Làm simulator trước; máy thật ở giai đoạn sau. |
| R3 | App không có cây element (Flutter không Semantics, game) | Fallback ảnh / `point_pct`; khuyến nghị dev bật Semantics identifier. |
| R4 | OTP, captcha, thanh toán | Hook / skill do user cung cấp (ví dụ API lấy OTP từ backend test). |
| R5 | Test oracle: AI không tự biết "đúng nghiệp vụ" | `intent` + `expect` do người xác nhận; Explorer chủ yếu bắt crash và luồng cơ bản. |
| R6 | Chi phí AI | Runner không AI; giới hạn ngân sách; model rẻ cho Explorer. |
| R7 | Copilot SDK là agent runtime (chạy Copilot CLI); câu trả lời có cấu trúc còn preview; điều khoản dùng trong server multi-tenant cần tenant tự chịu (token của chính họ) | SDK 1.0.16 đã nhận ảnh và mang sẵn runtime (kiểm 2026-10-01, D47). Adapter sau hai cờ (server + tenant), tắt công cụ có sẵn của Copilot; JSON sai vẫn qua hỏi lại / dự phòng như provider khác; DoD Phase 3 không phụ thuộc Copilot. |
| R8 | MinIO ngừng phát hành bản community; repo `minio/minio` đã bị gỡ khỏi Docker Hub (xác nhận 2026-09-28) | Dùng fork cộng đồng `pgsty/minio` (D26), ghim tag; chỉ dùng S3 API chuẩn nên thay được bằng RustFS/SeaweedFS/Garage mà không đổi code. |
| R9 | Snapshot (PNG) trong git repo project làm repo phình to | Chấp nhận ở MVP; cân nhắc Git LFS hoặc lưu ảnh theo content hash trên object storage. |
| R10 | Server chỉ chạy một instance (WS agent + git repo cục bộ) | Đủ cho Phase 1–5; mở rộng theo §17. |
| R11 | Giao thức JSON-RPC của `u2.jar` không có tài liệu chính thức, do một dự án cộng đồng duy trì | Ghim phiên bản `u2.jar`; bộ `*.device.test.ts` cho driver Android; interface `DeviceDriver` cho phép thay bằng Appium UiAutomator2 nếu cần (D27). |
| Q1 | ~~Chốt tech stack §19~~ | Đã chốt 2026-09-28 (D07). |
| Q2 | ~~Appium hay Maestro làm driver mặc định~~ | Android: UiAutomator2 trực tiếp (D27); iOS: Appium XCUITest. Giữ interface `DeviceDriver` để thêm Maestro sau. |
| Q3 | Tên thương mại và giấy phép | `coral` là tên dự án; kiểm tra nhãn hiệu / tên miền trước khi thương mại hóa. Rà đủ giấy phép của `u2.jar` (gói Python MIT, jar kèm `LICENSE-junit.txt` EPL) trước khi thương mại hóa — Phase 1 chỉ tải về lúc chạy, không phân phối lại (research Phase 1 R2). |
| Q4 | Mở rộng sang test web UI | Vẫn ngoài phạm vi đến hết Phase 6 (§1.3). **Khám phá** (AI): Explorer điều khiển trình duyệt qua **Playwright MCP** (§14.5, D30); mỗi thao tác được ghi lại (snapshot + locator Playwright sinh ra, bổ sung `testid`/`css`) để Test writer viết YAML. **Chạy lại** (không AI): runner dùng thư viện Playwright trực tiếp, không qua MCP (P1). Driver Playwright cài `UiDriver` (cây từ accessibility tree/DOM, `launch` = mở URL, reset = browser context mới); locator web `testid`, `role` + name, `css` (gắn nền tảng `web`); luật popup web (banner cookie, modal, `alert/confirm`); fingerprint = URL + cấu trúc DOM; lease = slot trình duyệt. Playwright MCP chạy trên agent để vào được web nội bộ sau NAT, server gọi qua kênh WS của agent (chốt chi tiết ở Phase 7). Giữ đường mở bằng D28; ROADMAP Phase 7 (tùy chọn). |
| Q5 | ~~coral làm MCP server cho AI bên ngoài~~ | Đã quyết: có, kèm cổng tới MCP server user tự cấu hình (§14.5, D32), Phase 6. |

---

## 21. Decision log

| # | Ngày | Quyết định | Lý do |
|---|---|---|---|
| D01 | 2026-09-28 | Mô hình lai: `coral-server` + `coral-agent` + `coral-web` | Thiết bị cần máy vật lý, iOS cần macOS; agent kết nối ra ngoài để chạy sau NAT. |
| D02 | 2026-09-28 | Runner không dùng AI; AI chỉ ở explore / write / heal / popup lạ | Nhanh, rẻ, tất định. |
| D03 | 2026-09-28 | Test case YAML với chuỗi locator dự phòng + `intent` | Chạy bền qua thay đổi UI; Healer hiểu mục đích. |
| D04 | 2026-09-28 | Tri thức lưu trong git repo mỗi project | Có lịch sử, diff, review; heal thành commit. |
| D05 | 2026-09-28 | Brain thay được qua interface + `brains.yaml` | Chọn provider theo vai trò, fallback, đo bằng benchmark. |
| D06 | 2026-09-28 | Cô lập theo run, không process riêng cho mỗi user | Tiết kiệm tài nguyên; cô lập ở dữ liệu, file, secret, ngữ cảnh AI. |
| D07 | 2026-09-28 | Chốt tech stack §19 (Node 24, TypeScript 6.0, pnpm 10 + Turborepo 2, Fastify 5, Drizzle + Postgres 17, BullMQ + Redis 7, React 19 + Vite 8, Vitest 5, ESLint 10 + Prettier 3) | Bổ sung các phần §19 bản 0.1 còn thiếu (runtime, build, WS, YAML, auth, CLI, router). |
| D08 | 2026-09-28 | Luật phụ thuộc: chỉ `packages/brain` dùng LLM SDK; chỉ `apps/server` dùng `@coral/brain`; app không import app | Viết P1 thành luật máy kiểm tra được, phủ cả phụ thuộc bắc cầu và `packages/cli`. |
| D09 | 2026-09-28 | Runner tách vào `packages/runner` (tạo ở Phase 1), dùng chung cho `apps/agent` và `coral run` | `coral run` cục bộ cần runner mà không phải import `apps/agent`. |
| D10 | 2026-09-28 | `tenants`, `users`, `refresh_tokens` là bảng toàn cục, không có `tenant_id` | Gỡ mâu thuẫn giữa "mọi bảng có tenant_id" và mô hình user nhiều tenant. |
| D11 | 2026-09-28 | UUID v7 sinh ở ứng dụng | Postgres 17 chưa có `uuidv7()`; không phụ thuộc phiên bản DB. |
| D12 | 2026-09-28 | `snake_case` cho mọi định dạng dây (YAML, JSON API, WS, cột DB); `camelCase` cho biến/hàm TS | Khớp ví dụ trong SPEC; không cần lớp đổi tên ở biên. |
| D13 | 2026-09-28 | `never_tap` áp dụng cho hành động máy tự quyết, không cho step người đã duyệt (§9.4) | Cho phép test chức năng "Xóa", "Đăng xuất" mà vẫn chặn AI. |
| D14 | 2026-09-28 | Chi tiết schema test case: tham số từng action (§7.1), `${var:name}`, khớp `class` tên ngắn, `visible` nhận danh sách locator, kiểm tra độ phủ nền tảng, `point_pct` theo cửa sổ | SPEC 0.1 chưa đủ để viết Zod schema. |
| D15 | 2026-09-28 | Git là nguồn sự thật cho nội dung; `test_cases` là chỉ mục; `status` chỉ ở DB; repo trên volume `CORAL_DATA_DIR` | Tránh hai nguồn sự thật và commit rác. |
| D16 | 2026-09-28 | Mọi hình thức dùng thiết bị cần lease (bảng `leases`); xem live view không cần lease | SPEC 0.1 chỉ nói lease cho run. |
| D17 | 2026-09-28 | Gộp proposal: `heal_proposals.kind` (locator_refresh/ai_heal/popup_rule), `rejection_outcome`, trạng thái `superseded`; `bugs.status` | §8.7 và §9.3 tạo proposal không khớp bảng cũ. |
| D18 | 2026-09-28 | Envelope WS thêm `re`; `ts` là epoch ms; frame live view gửi nhị phân; xử lý agent offline | Cần ghép cặp request/response và giảm băng thông. |
| D19 | 2026-09-28 | Secret cấp project hoặc tenant; agent che giá trị secret trong log/artifact; trước Phase 5 đọc từ `CORAL_SECRET_<NAME>` (chỉ dev) | Phase 1 cần secret nhưng mã hóa envelope ở Phase 5. |
| D20 | 2026-09-28 | Brain config lưu ở `tenants.settings`; API key provider là secret tenant (BYOK); Copilot làm sau cùng, sau cờ | Làm rõ "theo tenant"; giảm rủi ro R7. |
| D21 | 2026-09-28 | Test cần thiết bị đặt tên `*.device.test.ts`, chạy bằng `pnpm test:device` | Vitest không có cơ chế "tag" ổn định; quy ước theo tên file dễ lọc trong CI. |
| D22 | 2026-09-28 | Dùng GitHub Spec Kit (v1.0.12, skill `/speckit-*`); constitution = P1–P6; mỗi phase ROADMAP là một feature `specs/NNN-phase-N-*` | Chuẩn hóa vòng spec → plan → tasks → implement. |
| D23 | 2026-09-28 | Web: access token trong bộ nhớ, refresh token trong cookie httpOnly | Giảm rủi ro XSS lấy token. |
| D24 | 2026-09-28 | Hàm fingerprint màn hình nằm trong `packages/shared` | Runner cần cho `expect.screen`, Explorer cần cho app map. |
| D25 | 2026-09-28 | Popup guard chạy ngay sau launch; tối đa 3 popup mỗi step rồi fail `BLOCKED_BY_POPUP` | Tránh vòng lặp vô hạn; khớp §9.2 với §8.2. |
| D26 | 2026-09-28 | Object storage dev dùng image `pgsty/minio` (fork cộng đồng của MinIO) | `minio/minio` đã bị gỡ khỏi Docker Hub; fork dùng y hệt MinIO (lệnh, biến môi trường, healthcheck `mc ready`). |
| D27 | 2026-09-28 | Android: bỏ Appium, agent gọi thẳng server UiAutomator2 `u2.jar` (openatx/uiautomator2) qua JSON-RPC + `adb forward`; locator `image` bằng OpenCV WASM; iOS giữ Appium XCUITest | Theo đề xuất của Huynh: nhanh hơn, ít thành phần hơn, không cần session Appium hay APK test; agent vẫn viết bằng TypeScript (D07). |
| D28 | 2026-09-28 | Giữ đường mở rộng sang test web: tách `DeviceDriver` = `UiDriver` (trung lập) + `TargetLifecycle`; lõi `packages/runner` không import driver cụ thể; enum `platform` và union locator chỉ được mở rộng thêm, không đổi `coral/testcase@1` của file cũ | Theo ý Huynh: runner sau này có thể chạy test web (§20 Q4) mà không viết lại lõi; làm ngay từ Phase 1 thì gần như không tốn thêm. |
| D29 | 2026-09-28 | coral có cơ chế dùng MCP: server là MCP client cho các vai trò AI; khai báo `mcp.yaml` theo project, allowlist tool, log `tool_calls`; runner/agent chạy lại test không dùng MCP (§14.5) | Theo yêu cầu của Huynh; mở đường cho OTP/dữ liệu test (R4), tạo issue, và khám phá web; giữ P1, P5, P6. |
| D30 | 2026-09-28 | Phần test web (Phase 7): khám phá bằng Playwright MCP, chạy lại bằng Playwright trực tiếp | Theo yêu cầu của Huynh; AI dùng MCP để khám phá, còn test đã lưu chạy tất định không cần AI (P1). |
| D31 | 2026-09-28 | Test case được tạo và lưu trong chính coral (kho git project do coral quản lý, có từ Phase 1); nguồn: viết tay, Recorder, prompt, import test case thủ công (CSV/Excel/Gherkin → `coral/manualcase@1` → AI khám phá → YAML) | Trả lời Q1 của Huynh: coral là nơi sinh ra test case; import giúp chuyển bộ test thủ công sẵn có sang test tự động. |
| D32 | 2026-09-28 | coral làm MCP server (`/mcp`) cho AI bên ngoài, kiêm cổng tới MCP server user cấu hình (`expose: true`); không có tool duyệt proposal | Trả lời Q5 của Huynh; giữ P3 (người duyệt), P5 (scope theo token/tenant), P6 (allowlist, tác dụng phụ). |
| D33 | 2026-09-28 | Bổ sung giao thức §15: `agent.welcome`, `agent.heartbeat`, `item.result`, `error` | Cần cho heartbeat/lease (D16) và cập nhật kết quả từng test case; Huynh duyệt khi xem plan Phase 1. |
| D34 | 2026-09-28 | Quy ước test tích hợp `*.int.test.ts` (cần Postgres/Redis/MinIO), chạy bằng `pnpm test:int` với `CORAL_INT_TESTS=1`, có job CI riêng dựng `docker compose` | Tách test cần hạ tầng khỏi unit test nhanh; Huynh duyệt khi xem plan Phase 1. |
| D36 | 2026-09-29 | Hit-test theo element **nhận chạm** (mô hình dispatch của Android) thay vì element vẽ trên cùng; hộp thoại crash/ANR của **app khác** (xác định qua `dumpsys window`) được bỏ qua bằng Close app (Wait khi không có Close app); thao tác lỗi giữa chừng vì popup được làm lại một lần sau khi guard xử lý popup; thứ tự cửa sổ theo z-order của `dumpsys window windows` (dự phòng: toàn màn hình dưới cùng, cửa sổ nhỏ hơn, bàn phím, system UI trên cùng); dialog/popup là cửa sổ modal | Emulator Android 14 trong CI: logo `id/mTvTitle` không bấm được đè lên nút menu làm mọi run fail "covered"; "Pixel Launcher isn't responding" sau khi boot làm mọi launch fail `APP_NOT_RESPONDING`; dump u2 lúc liệt kê status bar trước, lúc dialog quyền trước (UiDevice gom cửa sổ vào một HashSet) nên không dùng được làm z-order. |
| D35 | 2026-09-29 | `expect.visible_text` = "chứa chuỗi" (chuẩn hóa khoảng trắng, phân biệt hoa/thường, chỉ `text`); `expect` thấy cả node dưới popup, chỉ target thao tác mới bị kiểm tra "bị che"; popup guard dùng cùng quy tắc để nhận ra step đang kiểm tra popup | Huynh duyệt khi xem US4 Phase 1: popup vẫn được xử lý ở thao tác kế tiếp (target bị che → guard); muốn khẳng định popup đã đi thì dùng `not_visible`. |
| D37 | 2026-09-29 | Test `*.device.test.ts` và các kiểm tra 🔌 chạy trên emulator Android 14 của GitHub Actions trong workflow `Device` (`.github/workflows/device.yml`, runner có KVM): khi push đụng đường dẫn thiết bị và khi chạy tay; vẫn bị bỏ qua trong `pnpm test` và các job CI thường. Ảnh ghép các step được lưu thành git blob để báo cáo đọc được | Container phát triển không có KVM; Huynh đồng ý dựng emulator trên cloud thay cho máy thật (Phase 2). Constitution 1.0.1 sửa câu "never run in CI". |
| D38 | 2026-09-30 | `WS /ws/ui` xác thực trong băng: message đầu tiên là `ui.auth { access_token }` trong 5 s (sai → đóng `4401`), token mới gửi lại trên cùng kết nối; quyền theo vai trò (`viewer` chỉ xem, FR-002a) | Trình duyệt không đặt được header `Authorization` cho WebSocket; token không nằm trong URL (log, lịch sử) — phù hợp D23 (Phase 2, research R2). |
| D39 | 2026-09-30 | Recorder: chạm vào **tâm element** được chọn (không phải điểm click), ghi chuỗi locator đã kiểm tra lại (id, text, desc, `rel`, `class_index`, ảnh; `point_pct` chỉ khi không có gì khác) + snapshot; bản ghi dở ở server (bảng `recordings`, snapshot trên S3, hết hạn 7 ngày); lưu = một commit gồm YAML + `snap/<slug>/`; chữ trùng giá trị secret được ghi thành `${secret:NAME}` (server thay trong step, đề xuất, inspect; agent che trong `tree.json` và log) | Theo P2 (lưu cách tìm element, chạm tâm bounds); bản ghi không mất khi tải lại trang (FR-016); SC-008 trên emulator cho thấy đề xuất kỳ vọng có thể mang giá trị secret đọc trên màn hình. |
| D40 | 2026-09-30 | Locator `image`: so toàn ảnh mẫu rồi kiểm lại **phần ruột** (bỏ 10 % mép) tại chỗ tìm được, điểm = số nhỏ hơn; ảnh mẫu/ruột phẳng không bao giờ khớp; co một lần theo `screen_width`, không dò nhiều tỉ lệ; kiểm "bị che" ở mức cửa sổ; ảnh đi theo job bằng nội dung (`<tenant>/assets/<sha256>`), `coral run --project-root` đọc từ đĩa | Nút cùng kiểu khác chữ đạt 0,865 khi chỉ so toàn ảnh (viền + nền lấn át) → khớp nhầm, trái SC-005; không chạm bừa quan trọng hơn khớp được khi mật độ màn hình khác (research R12). |
| D41 | 2026-10-01 | Dữ liệu Phase 3: `test_cases.source` thêm `ai_explore` (khám phá tự do) + `validation`/`draft_reason`/`flags`/`validated_at`; bảng `exploration_steps`, `findings`, `import_items`; `brain_calls` mỗi lần thử một dòng (`attempt`, `error`, `content_key` — nội dung đã che secret giữ 30 ngày); `tool_calls.blocked`; exploration bị gián đoạn khi server khởi động lại, job import tự chạy tiếp | Huynh duyệt plan Phase 3 (research R19, clarify Q2/Q5 của spec): cần trace để Test writer làm việc, nội dung AI để gỡ lỗi, lưu từng case để resume. |
| D42 | 2026-10-01 | Luật máy đọc của skill ở `skills/<name>/rules.yaml` (`coral/skill-rules@1`: `never_tap`, `forbidden`, `test_data`, `allow_submit`), tách khỏi `SKILL.md`; luật của mọi skill hợp nhất cho kiểm an toàn của Explorer; test case thủ công đã import ở `imports/<job_id>/*.yaml` (`coral/manualcase@1`) | Giữ `SKILL.md` đúng chuẩn Agent Skills; kiểm an toàn phải tất định, không phụ thuộc AI đọc skill nào (P6). |
| D43 | 2026-10-01 | `brains.yaml` thêm `providers` (model mặc định, `api_key_secret`), `limits.max_cost_usd_per_import`, `prices`; bảng đơn giá nền tảng là file dữ liệu `apps/server/ai-prices.yaml`; model thiếu đơn giá không được gọi; provider `fake`/`fake-alt` chỉ khi `CORAL_BRAIN_FAKE=1` | Giới hạn chi phí luôn có hiệu lực mà không hard-code tên model; CI chạy không cần key AI (clarify Q1). |
| D44 | 2026-10-01 | Lệnh agent `observe` (cây + `screen.jpg` + `ai.jpg` ≤ 1024 px, activity, crash); Explorer thao tác bằng `record` của Recorder (chuỗi locator lấy từ cây, AI chỉ chọn số element); `expect.screen` dùng `screenFingerprint` (D24) với `job.assign.items[].screens` từ app map | Locator trong test case AI sinh do mã Recorder tạo (P2); "nhìn" tách khỏi "làm" để server có cây + ảnh sau mỗi thao tác. |
| D45 | 2026-10-01 | Phụ thuộc: chỉ `@coral/brain` được dùng MCP SDK (`@modelcontextprotocol/*`, kiểm cả lockfile — bổ sung D08); `apps/server` dùng hàm thuần của `@coral/runner` (hit-test, trích locator, kiểm kỳ vọng trên cây tĩnh) | §14.5 (router là MCP client); bản nháp test case trên server phải giống hệt lúc chạy lại. |
| D46 | 2026-10-01 | Route Phase 3: tạo test case từ prompt = `POST /explorations` có `goal`; import qua `POST /projects/:id/imports` (xem trước) → `POST /imports/:id/start`; tri thức project `/projects/:id/agents-md`, `/skills/:name`, `/mcp`; `GET /brain-calls/:id`; `PATCH /testcases/:id` đổi trạng thái | Thay `testcases/generate` và `testcases/import` của bản phác thảo §16: prompt dùng chung máy Explorer, import cần bước xem trước và chọn cột (specs/004 contracts). |
| D47 | 2026-10-01 | GitHub Copilot là provider đầy đủ của Phase 3: `vision: true` (SDK 1.0.16 nhận ảnh base64) nên dùng được cả `explorer`; runtime CLI đi kèm SDK, adapter tắt mọi công cụ có sẵn của Copilot và chạy trong thư mục tạm rỗng, chỉ đưa công cụ của coral (vẫn ≤ 5 lượt); token tenant `providers.copilot.token_secret` hoặc nền tảng `CORAL_COPILOT_TOKEN`; đơn giá thêm `per_request` (USD mỗi lời gọi, Copilot tính theo premium request); adapter làm trong US1 cùng Claude và Gemini, không để cuối | Huynh yêu cầu hỗ trợ cả Copilot (2026-10-01); kiểm SDK thấy giả định `vision: false` của research R2 đã lỗi thời; giới hạn chi phí phải áp dụng cả cho provider không tính theo token. |
