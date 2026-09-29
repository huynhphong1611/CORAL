# Data Model: Phase 2 — Web UI, live view, recorder

**Feature**: `003-phase-2-web-recorder` · **Date**: 2026-09-29 · Nguồn: spec.md, research.md, SPEC §6, §13, D16

Kế thừa mọi quy ước của Phase 1 (`specs/002-phase-1-android-runner/data-model.md`): UUID v7, `timestamptz`, `snake_case`, `tenant_id` + repository có tenant scope (P5). Chỉ liệt kê phần **thêm/đổi**. Migration Drizzle mới; migration cũ không sửa.

## 1. Bảng Postgres

### Đổi

| Bảng | Thay đổi |
|---|---|
| `leases` | `kind` nhận thêm `live` (phiên điều khiển) và `recording` (phiên ghi); `holder_ref` = `live:<live_session_id>` / `recording:<recording_id>`. Ràng buộc "một lease mở mỗi thiết bị" giữ nguyên (SC-006). |
| `test_cases` | `source` nhận thêm `recorder`; `source_ref` = `recording:<id>`. |

### Thêm

| Bảng | Cột | Ràng buộc / ghi chú |
|---|---|---|
| `live_sessions` | id, tenant_id, device_id, user_id, lease_id, started_at, last_command_at, ended_at, end_reason | end_reason ∈ released/idle_timeout/agent_offline/replaced_by_recording; một phiên mở mỗi thiết bị (theo lease) |
| `device_commands` | id, tenant_id, device_id, live_session_id (null được), recording_id (null được), user_id, kind, params jsonb, status, error, created_at, finished_at | FR-009. kind ∈ tap/long_press/swipe/type/back/home/hide_keyboard/restart_app/prepare/record/inspect; `params` **không** chứa chữ đã gõ (chỉ `length`, và `secret` = tên nếu là ô mật khẩu); status ∈ sent/ok/failed/rejected |
| `recordings` | id, tenant_id, project_id, app_id, build_id, device_id, user_id, lease_id, status, steps jsonb, intent, slug, test_case_id, created_at, updated_at, saved_at, expires_at | status ∈ recording/stopped/saved/discarded/expired; `expires_at` = updated_at + 7 ngày; `steps` xem §3 |

## 2. Máy trạng thái

**Phiên điều khiển (live session)**
```
(không) ──POST control (lease live lấy được)──▶ open ──DELETE control──▶ ended(released)
                                                  ├─ không lệnh ≥ idle (10')──▶ ended(idle_timeout)
                                                  └─ agent offline ─────────▶ ended(agent_offline)
```
Thiết bị đang có lease `run`/`recording` → POST control trả 409 `device_busy` (US3 kịch bản 5).

**Recording**
```
recording ──stop / agent offline / idle──▶ stopped ──resume (lấy lại lease)──▶ recording
    │                                          │
    └──────────────save (hợp lệ)───────────────┴──▶ saved      ├─ discard ──▶ discarded
                                                               └─ quá 7 ngày ──▶ expired (xóa object S3)
```
`recording` giữ lease `recording` trên thiết bị; `stopped` đã thả lease nhưng vẫn sửa/lưu được (snapshot đã ở S3).

**Device (hiển thị trên web)**: `offline | idle | busy(run) | controlled(by user) | recording(by user)` — suy ra từ `devices.status` + lease đang mở.

## 3. Step trong bản ghi (`recordings.steps`, JSON)

```json
{
  "n": 3,
  "step": { "id": "s3", "action": "tap", "target": [ { "android_id": "id/menuIV" }, { "desc": "View menu" }, { "class_index": { "class": "ImageView", "index": 0 } }, { "image": { "path": "snap/<slug>/s3/element.png", "screen_width": 1080 } } ], "expect": [ { "visible_text": "Log In" } ] },
  "suggestions": [ { "visible_text": "Log In" }, { "visible": [ { "android_id": "id/loginTV" } ] } ],
  "warnings": [ "no_expect_after_tap" | "never_tap" ],
  "snapshot": { "screen": "<s3 key>", "tree": "<s3 key>", "element": "<s3 key>", "screen_width": 1080, "screen_height": 2400 },
  "recorded_at": "2026-09-29T…"
}
```
- `step` là đúng một phần tử `steps[]` của `coral/testcase@1` (Zod của shared); đường dẫn `image` là đường dẫn **sau khi lưu** (đổi `<slug>` khi người dùng đặt tên).
- Chữ gõ ở ô mật khẩu chỉ xuất hiện dạng `${secret:NAME}`.

## 4. Kho git project (bổ sung §13)

```
testcases/<slug>.yaml
snap/<slug>/<step_id>/screen.jpg      # ảnh màn hình lúc ghi (sau khi màn hình ổn định, trước thao tác)
snap/<slug>/<step_id>/tree.json       # ElementNode[] đã che secret
snap/<slug>/<step_id>/element.png     # ảnh cắt element đích (locator image)
```
Lưu từ Recorder = một commit chứa YAML + toàn bộ `snap/<slug>/`; lưu lại cùng slug thay thế thư mục `snap/<slug>/` trong cùng commit. Editor chỉ sửa YAML.

## 5. Object storage (bổ sung)

```
<tenant_id>/recordings/<recording_id>/<n>/{screen.jpg,tree.json,element.png}   # hết hạn cùng recording
<tenant_id>/assets/<sha256>                                                      # ảnh locator giao cho agent (content-addressed)
```
Key luôn do server sinh (T062); presigned PUT cho agent, presigned GET cho web (15 phút).

## 6. Kiểu dữ liệu dùng chung (`packages/shared`)

- Locator `image`: `string | { path: string, threshold?: number (0.5–1), screen_width?: number }`.
- `ui` protocol (contracts/ui-ws.md), `stream.frame` header, `DeviceCommand` union (contracts/agent-ws-phase2.md).
- `RecordingStep` (§3), DTO REST mới (contracts/rest-api-phase2.md).
