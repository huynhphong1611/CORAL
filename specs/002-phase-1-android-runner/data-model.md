# Data Model: Phase 1 — Runner tất định trên Android + server tối thiểu

**Feature**: `002-phase-1-android-runner` · **Date**: 2026-09-28 · Nguồn: SPEC §6, D10–D17, D31

Quy ước chung: `id uuid` (UUID v7 sinh ở ứng dụng — D11); thời gian `timestamptz`; tên cột `snake_case` (D12); mọi bảng nghiệp vụ có `tenant_id uuid not null references tenants(id)` và mọi truy vấn đi qua repository có tenant scope, đặt `set_config('app.tenant_id', …, true)` trong transaction (sẵn cho RLS ở Phase 5).

## 1. Bảng Postgres (Phase 1)

### Định danh (toàn cục — D10)

| Bảng | Cột | Ràng buộc |
|---|---|---|
| `tenants` | id, name, plan (`'dev'`), settings jsonb default `{}`, created_at | |
| `users` | id, email, password_hash, name, created_at | `email` unique (lowercase) |
| `memberships` | tenant_id, user_id, role, created_at | PK (tenant_id, user_id); role ∈ owner/admin/member/viewer |
| `refresh_tokens` | id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at | index token_hash |

### Nghiệp vụ

| Bảng | Cột | Ràng buộc / index |
|---|---|---|
| `projects` | id, tenant_id, name, git_repo_path, created_at | unique (tenant_id, name) |
| `apps` | id, tenant_id, project_id, platform (`android`), package_or_bundle_id, name, created_at | unique (project_id, platform, package_or_bundle_id) |
| `builds` | id, tenant_id, app_id, version, artifact_key, checksum_sha256, size_bytes, uploaded_by, created_at | index (app_id, created_at desc) |
| `agents` | id, tenant_id, name, token_hash, os, version, capabilities jsonb, status, last_seen_at, revoked_at, created_at | unique token_hash; status ∈ online/offline/revoked |
| `devices` | id, tenant_id, agent_id, platform, kind, model, os_version, api_level, udid, status, last_seen_at, created_at | unique (agent_id, udid); kind ∈ real/emulator/simulator; status ∈ idle/leased/offline |
| `leases` | id, tenant_id, device_id, kind, holder_ref, acquired_at, expires_at, released_at, release_reason | **partial unique (device_id) where released_at is null**; kind ∈ run (exploration/live từ Phase 2–3) |
| `test_cases` | id, tenant_id, project_id, slug, path_in_repo, intent, tags text[], platforms text[], status, head_commit, source, source_ref, updated_by, created_at, updated_at | unique (project_id, slug); status ∈ draft/active/quarantined (mặc định draft); source ∈ manual/recorder/ai_prompt/ai_import (Phase 1: manual) |
| `project_files` | tenant_id, project_id, kind, path_in_repo, head_commit, updated_at | PK (project_id, kind); kind ∈ popups (Phase 3 thêm mcp) |
| `runs` | id, tenant_id, project_id, build_id, device_id, trigger, status, failure_code, popups_commit, queued_at, started_at, finished_at, created_by | status ∈ queued/running/passed/failed/cancelled/error; trigger ∈ manual/schedule/ci/validation; index (tenant_id, queued_at desc) |
| `run_items` | id, tenant_id, run_id, test_case_id, commit, position, status, failure_code, failed_step_id, started_at, finished_at | unique (run_id, position); status ∈ pending/running/passed/failed/skipped/error |
| `run_steps` | id, tenant_id, run_item_id, step_index, step_id, action, status, locator_used_index, degraded, unstable, duration_ms, failure_code, message, popups_handled jsonb, artifact_prefix, finished_at | unique (run_item_id, step_index); status ∈ passed/failed |
| `audit_log` | id, tenant_id, actor, action, target, meta jsonb, created_at | ghi: login, tạo/thu hồi agent, tạo run, hủy run |

Chưa tạo ở Phase 1: `api_tokens`, `secrets` (Phase 5), `explorations`, `brain_calls`, `tool_calls` (Phase 3), `heal_proposals`, `bugs` (Phase 4), `import_jobs` (Phase 3).

### Quy tắc kiểm tra dữ liệu

- `test_cases.slug` = `id` trong YAML; `path_in_repo` = `testcases/<slug>.yaml`; YAML phải qua `validateTestCase` trước khi commit.
- Tạo run: mọi `test_case_ids` thuộc cùng project với run; `platforms` chứa `android`; thiết bị thuộc tenant; secret được tham chiếu phải có giá trị (R13); build thuộc app của project.
- `run_steps.locator_used_index` là chỉ số trong danh sách `target` **gốc** (kể cả locator của nền tảng khác); `degraded = locator_used_index > first_applicable_index`.

## 2. Máy trạng thái

**Run**
```
queued ──lease lấy được + job.ack──▶ running ──job.done──▶ passed | failed
  │                                   │
  ├─queue timeout (10')──▶ error      ├─cancel──▶ cancelled
  └─cancel──▶ cancelled               ├─run timeout (30')──▶ error (TIMEOUT)
                                      └─agent offline──▶ error (DEVICE_OFFLINE)
```
Run `passed` khi mọi item `passed`; `failed` khi có item `failed`; `error` khi hạ tầng hỏng.

**Run item**: `pending → running → passed | failed | error`; item chưa chạy khi run bị hủy/lỗi → `skipped`.

**Device**: `offline ⇄ idle ⇄ leased` — `idle → leased` chỉ qua insert lease thành công; `leased → idle` khi lease giải phóng; mọi trạng thái → `offline` khi agent mất heartbeat hoặc thiết bị biến mất khỏi `adb devices`.

**Lease**: mở (`released_at is null`) → giải phóng với `release_reason` ∈ done/cancelled/timeout/agent_offline/ack_timeout. `expires_at` gia hạn mỗi heartbeat; lease quá hạn bị dọn bởi job định kỳ.

**Agent**: `offline → online` (kết nối + `agent.hello` hợp lệ) → `offline` (mất 3 heartbeat / đóng kết nối); `revoked` là cuối cùng.

## 3. Kho git project (D15, D31)

```
${CORAL_DATA_DIR}/repos/<tenant_id>/<project_id>/
├── testcases/<slug>.yaml     # coral/testcase@1
├── popups.yaml               # coral/popups@1 (khởi tạo từ examples/popups.example.yaml)
└── snap/                     # snapshot mốc — chưa dùng ở Phase 1
```
Commit đầu tiên khi tạo project: `popups.yaml` mặc định + `README.md`. `test_cases.head_commit` và `project_files.head_commit` cập nhật trong cùng thao tác lưu.

## 4. Object storage (S3/MinIO)

```
<bucket>/<tenant_id>/builds/<build_id>.apk
<bucket>/<tenant_id>/runs/<run_id>/<run_item_id>/<step_index>-<step_id>/screenshot.png
                                                                    /tree.json      # ElementNode[] đã che secret
                                                                    /device.log     # chỉ khi step lỗi
<bucket>/<tenant_id>/runs/<run_id>/<run_item_id>/result.json                     # tổng kết item
```
`run_steps.artifact_prefix` = thư mục của step. Lifecycle 30 ngày cho artifact run (object dưới `runs/` được gắn tag `coral-retention=run-artifact` khi upload — R11).

## 5. Kiểu dữ liệu dùng chung (`packages/shared`)

- `ElementNode` `{ ref, platform_id, text, desc, class, bounds: { x, y, w, h }, clickable, enabled, visible, package_or_bundle, children, android?: { password, focused, scrollable, drawing_order, window_index } }`.
- `StepResult` `{ step_index, step_id, action, status, locator_used_index?, degraded, unstable, duration_ms, failure_code?, message?, popups_handled: [{ rule, button }], artifacts: { screenshot, tree, log? } }`.
- `FailureCode` = §8.5.
