# Data Model: Phase 3 — Brain layer, Explorer, Test writer

**Feature**: `004-phase-3-brain-explorer` · **Date**: 2026-09-30 · Nguồn: spec.md, research.md, SPEC §6, §10, §11, §13, §14, D16, D20

Kế thừa mọi quy ước của Phase 1–2: UUID v7, `timestamptz`, `snake_case`, `tenant_id` + repository có tenant scope (P5). Chỉ liệt kê phần **thêm/đổi**. Migration Drizzle mới; migration cũ không sửa.

## 1. Bảng Postgres

### Đổi

| Bảng | Thay đổi |
|---|---|
| `tenants` | `settings.brains`: cấu hình bộ não của tenant (`coral/brains@1` đã kiểm, dạng JSON — contracts/brains-yaml.md). Không có key API, chỉ tên secret. |
| `leases` | `kind = exploration` (đã có trong enum). `holder_ref` = `exploration:<id>`. |
| `test_cases` | `source` thêm `ai_explore`. Thêm cột:<br>• `validation` jsonb null: `{ runs: [{ run_id, status, failure_code?, step_id? }], commit }`<br>• `draft_reason` text null ∈ `validation_failed \| changed_during_validation \| needs_human \| ambiguous \| app_mismatch`<br>• `flags` text[] mặc định `{}` ∈ `needs_review_never_tap`<br>• `validated_at` timestamptz null |
| `runs` | `trigger = validation` (đã có); thêm `validation_of` uuid null → `test_cases.id`. |

### Thêm

| Bảng | Cột | Ràng buộc / ghi chú |
|---|---|---|
| `explorations` | id, tenant_id, project_id, app_id, build_id, device_id, user_id, lease_id, kind, goal, budget jsonb, max_tests, status, stop_reason, stats jsonb, screens jsonb, appmap_commit, writer_report jsonb, import_item_id, created_at, started_at, finished_at | **`kind`** ∈ `explore` \| `prompt` \| `import`.<br>**`budget`**: `{ max_steps, max_depth, max_minutes, max_cost_usd }`.<br>**`status`** ∈ `queued`, `running`, `writing`, `validating`, `done`, `stopped`, `failed`, `interrupted`.<br>**`stop_reason`** ∈ `max_steps`, `max_depth`, `max_minutes`, `budget`, `daily_limit`, `goal_reached`, `goal_not_reached`, `user_stopped`, `device_offline`, `ai_unavailable`, `interrupted`, `error`.<br>**`stats`**: `{ steps, refused, screens, new_screens, transitions, findings, cost_usd, tests_written, tests_active }`.<br>**`screens`**: màn đã gặp `[{ fingerprint, id, name, package, activity?, first_step, is_new, first_seen_at }]`, ghi mỗi khi đặt tên màn mới — app map được ghi từ đây (kể cả sau khi server khởi động lại).<br>**`writer_report`** (D48, null tới khi Test writer chạy): `{ flows, skipped: [{ slug, name, intent, reason, duplicate_of?, message? }], error }` — `flows` = số flow AI chọn; `reason` ∈ `duplicate` (cùng chuỗi thao tác với test case `duplicate_of` của project), `invalid`, `no_steps`; `error` ∈ `budget`, `ai_unavailable`, `invalid_output` hoặc null; với case import (US6) thêm `outcome` ∈ `written`, `needs_human`, `ambiguous`, `app_mismatch`, `evidence_step?`, `explanation?` (Test writer nói case thủ công đi tới đâu). |
| `exploration_steps` | id, tenant_id, exploration_id, n, segment, fingerprint, screen_id, decision jsonb, status, refusal, step jsonb, suggestions jsonb, flags text[], artifact_prefix, brain_call_id, cost_usd, created_at | **`status`** ∈ `done`, `refused`, `failed`, `popup`, `restart`.<br>**`refusal`** ∈ `not_found`, `not_actionable`, `never_tap`, `skill_forbidden`, `point_pct_not_allowed`, `invented_submit`, `invalid_text`.<br>**`step`**: step `coral/testcase@1` do `record` trả (có chuỗi locator).<br>**`suggestions`**: kỳ vọng `record` đề xuất sau bước (Recorder, không AI) — ứng viên của Test writer.<br>**`flags`** ∈ `never_tap`, `mcp_value`, `invented_text`.<br>**`segment`** tăng mỗi lần mở app sạch/mở lại.<br>Unique `(exploration_id, n)`. |
| `findings` | id, tenant_id, project_id, exploration_id, step_n, kind, log_excerpt, artifact_prefix, created_at | **`kind`** ∈ `crashed`, `not_responding`. Ứng viên bug của Phase 4. |
| `brain_calls` | id, tenant_id, role, provider, model, attempt, tokens_in, tokens_out, tokens_cached, cost_usd, latency_ms, ok, error, ref_type, ref_id, content_key, created_at | Theo SPEC §6, thêm các cột mới.<br>**`role`** ∈ `explorer`, `writer`.<br>**`attempt`**: số thứ tự trong chuỗi dự phòng/hỏi lại.<br>**`error`** ∈ `timeout`, `rate_limited`, `auth`, `refusal`, `invalid_output`, `provider_error`, `budget`.<br>**`ref_type`** ∈ `exploration`, `import_job`.<br>**`content_key`**: key S3 (30 ngày).<br>Index `(tenant_id, created_at)` để cộng chi phí trong ngày. |
| `tool_calls` | id, tenant_id, brain_call_id, mcp_server, tool, args_redacted jsonb, ok, blocked, error, latency_ms, created_at | Theo SPEC §6 + `blocked`, `error` (`not_allowed`, `side_effects_disabled`, `timeout`, `server_error`). |
| `import_jobs` | id, tenant_id, project_id, app_id, build_id, device_id, created_by, source_format, file_name, sheet, mapping jsonb, status, budget jsonb, stats jsonb, report jsonb, manual_commit, created_at, started_at, finished_at | **`source_format`** ∈ `csv`, `xlsx`, `gherkin`.<br>**`status`** ∈ `preview`, `running`, `done`, `cancelled`, `failed`.<br>**`budget`**: `{ max_cost_usd, max_minutes }`.<br>**`sheet`**: sheet XLSX đã đọc (để `PATCH` đọc lại file theo mapping mới).<br>**`report`**: xem §3. |
| `import_items` | id, tenant_id, import_job_id, n, manual_path, title, status, reason, evidence jsonb, exploration_id, test_case_id, cost_usd, updated_at | **`status`** ∈ `pending`, `running`, `active`, `draft`, `not_processed`.<br>**`reason`** ∈ `needs_human`, `ambiguous`, `app_mismatch`, `validation_failed`, `duplicate`.<br>**`evidence`**: `{ step_n?, artifact_prefix?, message }`.<br>Unique `(import_job_id, n)`. |

Mọi bảng mới có `tenant_id` và đi qua repository có tenant scope (P5).

## 2. Máy trạng thái

**Exploration**
```
queued ──lease lấy được──▶ running ──ngân sách / mục tiêu / dừng / mất thiết bị──▶ writing ──▶ validating ──▶ done
   │                         │                                                     │
   │                         ├─ lỗi không phục hồi ──▶ failed                      └─ không có test case ──▶ done
   │                         └─ server khởi động lại ──▶ interrupted (app map đã có được ghi, không viết test)
   └─ thiết bị bận ──▶ 409 device_busy (không tạo)
```
- `stopped`: người dùng dừng khi đang `running`. Vẫn qua `writing` → `validating` → `done`; `stop_reason = user_stopped`.
- App map được commit khi rời `running`, dù vì lý do gì. Lease được thả trước `writing`.

**Test case do AI sinh**
```
(lưu) draft ──2 run validation pass──▶ active
          └──một run fail / sửa trong lúc xác thực──▶ draft (draft_reason)
```
Cờ `needs_review_never_tap` hoặc lý do `needs_human` → luôn ở `draft`, không chạy xác thực.

**Job import**
```
preview ──confirm──▶ running ──hết case──▶ done
   │                   ├─ hủy / hết ngân sách ──▶ cancelled (case chưa làm = not_processed)
   └─ bỏ ──▶ (xóa)     └─ server khởi động lại ──▶ running (tự tiếp từ case pending đầu tiên)
```

**Import item**: `pending → running → active | draft | not_processed`. Case đang `running` lúc server khởi động lại quay về `pending`.

## 3. JSON trong DB

**`explorations.stats`**: `{ "steps": 42, "refused": 3, "screens": 9, "new_screens": 4, "transitions": 17, "findings": 0, "cost_usd": 0.82, "tests_written": 5, "tests_active": 4 }`

**`exploration_steps.decision`** (câu trả lời AI đã kiểm, contracts/brain.md):
```json
{ "action": "tap", "element": 12, "reason": "Open the catalog menu, not tried yet" }
```

**`import_jobs.report`**:
```json
{
  "total": 10, "active": 8,
  "draft": { "needs_human": 1, "ambiguous": 0, "app_mismatch": 1, "validation_failed": 0, "duplicate": 0 },
  "not_processed": 0, "cost_usd": 4.1,
  "items": [ { "n": 1, "title": "Login with valid account", "status": "active", "test_case_id": "…" } ]
}
```

**`test_cases.validation`**:
```json
{ "commit": "abc123", "runs": [ { "run_id": "…", "status": "passed" }, { "run_id": "…", "status": "failed", "failure_code": "TARGET_NOT_FOUND", "step_id": "s4" } ] }
```

## 4. Kho git project (bổ sung §13)

```
AGENTS.md                               # luật chung cho mọi vai trò AI (Markdown)
skills/<name>/SKILL.md                  # frontmatter name + description, nội dung Markdown
skills/<name>/rules.yaml                # coral/skill-rules@1 (contracts/project-knowledge.md)
mcp.yaml                                # coral/mcp@1
appmap/screens.json                     # coral/appmap@1 (contracts/appmap.md)
appmap/snap/<screen_id>/{screen.jpg,tree.json}
imports/<job_id>/<nnn>-<slug>.yaml      # coral/manualcase@1 (contracts/manualcase.md)
testcases/<slug>.yaml                   # test case AI sinh, như Recorder
snap/<slug>/<step_id>/{screen.jpg,tree.json,element.png}
```

Ai ghi và ghi lúc nào:
- App map: **một** commit mỗi exploration, lúc exploration rời `running`.
- Mỗi test case AI sinh: một commit.
- Test case thủ công: một commit khi xác nhận import.
- Tri thức project: mỗi lần lưu một commit.

## 5. Object storage (bổ sung)

```
<tenant>/explorations/<exploration_id>/<n>/{screen.jpg,ai.jpg,tree.json}               # observe trước bước n; trace, giữ 30 ngày (tag)
<tenant>/explorations/<exploration_id>/<n>/{step.jpg,step.json,element.png}             # record ngay trước thao tác (snapshot của step trong test case)
<tenant>/explorations/<exploration_id>/0/{step.jpg,step.json}                            # prepare lúc bắt đầu
<tenant>/ai/<ref_type>/<ref_id>/<brain_call_id>.json                                    # nội dung lời gọi AI, 30 ngày (FR-006a)
<tenant>/imports/<job_id>/source.<ext>                                                  # file người dùng tải lên, xóa khi job xong
```

## 6. Kiểu dữ liệu dùng chung (`packages/shared`)

- `brains/schema.ts`: `coral/brains@1`, danh sách vai trò và provider.
- `mcp/schema.ts`: `coral/mcp@1`.
- `knowledge/skill.ts`: frontmatter `SKILL.md` và `coral/skill-rules@1`.
- `manualcase/schema.ts`: `coral/manualcase@1`, kiểu `ImportMapping`.
- `appmap/schema.ts`: `coral/appmap@1`.
- `appmap/fingerprint.ts`: `screenFingerprint()` (D24).
- `ai/decisions.ts`: `ScreenSummary`, `ActionDecision`, `TestPlan` (contracts/brain.md).
- `api/`: DTO REST mới (contracts/rest-api-phase3.md).
- `protocol/ui.ts`: message `exploration.*` và `import.*` (contracts/ui-ws-phase3.md).
- `protocol/messages.ts`: lệnh `observe`, `job.assign.items[].screens` (contracts/agent-ws-phase3.md).
