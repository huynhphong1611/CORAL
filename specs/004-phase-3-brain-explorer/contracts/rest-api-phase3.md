# Contract: REST API — phần thêm ở Phase 3

Bổ sung cho `specs/002-phase-1-android-runner/contracts/rest-api.md` và `specs/003-phase-2-web-recorder/contracts/rest-api-phase2.md`. Quy ước lỗi, auth, tenant và tiền tố `/api` phía trình duyệt giữ nguyên. DTO Zod trong `packages/shared/src/api`.

**Vai trò**:
- ✍ = `owner`/`admin`/`member`; 🔑 = chỉ `owner`/`admin`; các route khác mọi vai trò trong tenant xem được.
- `viewer` gọi route ✍, hoặc vai trò khác gọi route 🔑 → `403 { error: { code: "forbidden" } }` (FR-043).
- Tài nguyên của tenant khác → `404` (FR-042).

## Bộ não AI

| Method | Path | Body → Response |
|---|---|---|
| GET | `/brains/config` | → `{ source: "tenant"\|"platform"\|"none", yaml, config, providers: [{ id, enabled, vision }] }`. `Accept: application/yaml` → chỉ YAML. |
| PUT 🔑 | `/brains/config` | Body là YAML (`Content-Type: application/yaml`) hoặc JSON `coral/brains@1` → 200 như GET.<br>400 `validation_failed` kèm `details[{ path, line, column, code, message }]` (cùng dạng lỗi YAML của Phase 1). Các `code`: `unknown_provider`, `provider_disabled`, `vision_required`, `price_missing`, `invalid_limit`, `schema`.<br>Ghi `audit_log` (`brains.config.update`). |
| GET | `/usage/ai?from&to&group=day\|role\|provider` | → `{ rows: [{ key, calls, tokens_in, tokens_out, cost_usd }], total_cost_usd, today: { cost_usd, limit_usd } }` (FR-010). Ngày theo UTC. |
| GET | `/brain-calls/:id` | → `{ id, role, provider, model, attempt, ok, error, tokens_in, tokens_out, cost_usd, latency_ms, created_at, content: BrainCallContent \| null, tool_calls: ToolCall[] }`. `content` = null khi quá 30 ngày (FR-006a). Ảnh trong `content` là URL presigned. |

## Tri thức project

| Method | Path | Body → Response |
|---|---|---|
| GET | `/projects/:id/agents-md` | → `{ content, head_commit }` (không có file → `content: ""`). |
| PUT ✍ | `/projects/:id/agents-md` | `{ content, base_commit }` → `{ head_commit }`. Tối đa 64 KB.<br>409 `conflict` khi `base_commit` khác head, như editor Phase 2. |
| GET | `/projects/:id/skills` | → `[{ name, description, has_rules }]`. |
| GET | `/projects/:id/skills/:name` | → `{ name, skill_md, rules_yaml \| null, head_commit }`. |
| PUT ✍ | `/projects/:id/skills/:name` | `{ skill_md, rules_yaml?, base_commit }` → `{ head_commit }`.<br>400 `validation_failed` khi frontmatter thiếu `name`/`description`, hoặc `name` ≠ tên trong đường dẫn, hoặc `rules.yaml` sai schema.<br>`name` khớp `^[a-z0-9][a-z0-9-]{0,63}$`. |
| DELETE ✍ | `/projects/:id/skills/:name?base_commit=` | → 204 (một commit xóa thư mục skill). |
| GET | `/projects/:id/mcp` | → `{ yaml, head_commit }`. |
| PUT 🔑 | `/projects/:id/mcp` | `{ yaml, base_commit }` → `{ head_commit }`.<br>400 khi schema sai hoặc khai báo server stdio không thuộc allowlist nền tảng (`stdio_not_allowed`).<br>Ghi `audit_log` (`mcp.update`). |

## Exploration (và tạo test case từ prompt)

| Method | Path | Body → Response |
|---|---|---|
| POST ✍ | `/explorations` | `{ project_id, app_id, build_id, device_id, goal?, budget?: { max_steps?, max_depth?, max_minutes?, max_cost_usd? }, max_tests? }` → 201 `Exploration`.<br>`goal` có → `kind = prompt`. Giá trị thiếu lấy mặc định: 60 / 8 / 20 / `limits.max_cost_usd_per_exploration`; `max_tests` = 5 (1 khi `kind = prompt`).<br>Giới hạn: `goal` ≤ 1 000 ký tự; `max_steps` ≤ 500, `max_depth` ≤ 50, `max_minutes` ≤ 240, `max_cost_usd` ≤ 10 000; `max_tests` 1–20.<br>Lỗi: 409 `device_busy` \| `device_offline` \| `brains_not_configured` \| `daily_limit_reached` \| `too_many_explorations` (tenant đã có `CORAL_MAX_EXPLORATIONS` exploration đang chạy). |
| GET | `/explorations?project_id&status` | → `Exploration[]` (không kèm bước). |
| GET | `/explorations/:id` | → `Exploration` + `appmap` (màn hình và chuyển màn của exploration này, URL ảnh presigned) + `test_cases[]` (`{ id, slug, status, draft_reason, flags }`) + `findings[]`. |
| GET | `/explorations/:id/steps?after=<n>&limit=` | → `ExplorationStep[]`: `{ n, segment, screen: { id, name }, decision, status, refusal, step, flags, brain_call_id, screenshot_url, cost_usd, created_at }`. |
| POST ✍ | `/explorations/:id/stop` | → 202. Exploration dừng sau thao tác đang làm (SC-011: ≤ 15 s), rồi viết và xác thực test như bình thường. |

`Exploration` = `{ id, project_id, app_id, build_id, device_id, kind, goal, budget, max_tests, status, stop_reason, stats, created_by: { id, name }, created_at, started_at, finished_at }`.

## App map

| Method | Path | Body → Response |
|---|---|---|
| GET | `/projects/:id/appmap` | → `coral/appmap@1` tại head + URL ảnh (qua route file bên dưới). Chưa có → `{ screens: [], transitions: [] }`. |
| GET | `/projects/:id/files/*path` | Nội dung file trong repo tại `?commit=` (mặc định head). Chỉ trong `appmap/snap/` và `imports/`. Cache như route file test case của Phase 2. |

## Import test case thủ công

| Method | Path | Body → Response |
|---|---|---|
| POST ✍ | `/projects/:id/imports` | Multipart: `file` (≤ 5 MB), `format?` (`csv`\|`xlsx`\|`gherkin`, mặc định đoán theo đuôi), `sheet?` → 201 `ImportPreview`:<br>`{ import_job_id, columns: [{ index, header }], mapping, cases: ManualCase[] (≤ 200), errors: [{ row \| line, message }] }`. Job ở `preview`. |
| PATCH ✍ | `/imports/:id` | `{ mapping }` → `ImportPreview` đọc lại theo mapping mới (chỉ khi `preview`). |
| POST ✍ | `/imports/:id/start` | `{ app_id, build_id, device_id, budget?: { max_cost_usd?, max_minutes? } }` → 202 `ImportJob`.<br>Ghi `imports/<id>/*.yaml` thành một commit, trạng thái `running`.<br>409 như `POST /explorations`; 400 `no_cases` khi không có case hợp lệ. |
| GET | `/imports?project_id` | → `ImportJob[]`. |
| GET | `/imports/:id` | → `ImportJob` + `items[]`: `{ n, title, status, reason, evidence, exploration_id, test_case_id }` + `report` khi xong. |
| POST ✍ | `/imports/:id/cancel` | → 202. Case chưa làm thành `not_processed`. |
| DELETE ✍ | `/imports/:id` | Chỉ khi `preview` → 204 (xóa file tạm). |

`mapping` = `{ title: col, preconditions?: col, steps: col[], expected: col[], id?: col, header_row: number }` (cột theo chỉ số, từ 0). Gherkin không cần mapping.

## Test case (bổ sung)

- `GET /projects/:id/testcases` và `GET /testcases/:id` thêm các trường `source`, `source_ref`, `draft_reason`, `flags`, `validation`.
- `GET /projects/:id/testcases?source=ai_explore|ai_prompt|ai_import&status=` để lọc.
- `PATCH /testcases/:id` ✍ `{ status: "draft" | "active" | "quarantined" }` — người dùng đổi trạng thái tay.
  - `needs_review_never_tap` → `active` cần 🔑 và ghi `audit_log` (§9.4: duyệt riêng).
