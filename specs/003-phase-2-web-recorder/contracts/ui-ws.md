# Contract: `WS /ws/ui` — trình duyệt ↔ server (Phase 2)

Nguồn: SPEC §15–§16, D18, research R3, R5, R7. Cùng envelope JSON với giao thức agent: `{ v: 1, type, id, ts, re?, payload }` (UUID v7, epoch ms, `re` với message trả lời). Zod ở `packages/shared/src/protocol/ui.ts`. Tối đa 256 KB / message JSON; khung hình là **binary frame** riêng.

## Kết nối và xác thực

1. Trình duyệt mở `WS /api/ws/ui` (dev: Vite proxy `ws: true` → `/ws/ui`).
2. Message đầu tiên phải là `ui.auth { access_token }` trong 5 s → server trả `ui.ready { user_id, tenant_id, role }` (`re` = id của `ui.auth`). Sai/hết hạn/quá 5 s → đóng `4401`.
3. Access token sắp hết hạn: client refresh qua REST rồi gửi `ui.auth` mới trên cùng kết nối (không đóng).
4. Mọi dữ liệu giới hạn trong tenant của token (P5). Message sai → `error { code: "invalid_message" }`, >20 lần/phút → đóng `4400`.

## Message

| Hướng | type | payload | Ghi chú |
|---|---|---|---|
| C→S | `ui.auth` | `{ access_token }` | trả `ui.ready` |
| C→S | `run.watch` / `run.unwatch` | `{ run_id }` | sau `watch`: `run.updated` và `run.step` khi có thay đổi |
| S→C | `run.updated` | `{ run_id, status, failure_code?, items: [{ id, status, failure_code?, failed_step_id? }], started_at?, finished_at? }` | |
| S→C | `run.step` | `{ run_id, run_item_id, step_index, step_id, status, failure_code?, degraded, duration_ms }` | ảnh lấy qua REST (URL presigned) |
| S→C | `devices.updated` | `{ devices: Device[] }` (như `GET /devices`, kèm `activity`) | gửi khi trạng thái/lease đổi; client không cần polling |
| C→S | `stream.subscribe` / `stream.unsubscribe` | `{ device_id }` | mọi vai trò; thiết bị offline → `error { code: "device_offline" }` |
| S→C | *(binary)* `stream.frame` | header `{ type: "stream.frame", device_id, seq, ts, width, height, device_width, device_height, rotation, mime }` + ảnh | framing: `[uint32 BE độ dài header][header JSON][ảnh]` |
| S→C | `stream.status` | `{ device_id, state: "starting"\|"live"\|"stalled"\|"stopped", reason? }` | `stalled` khi > 5 s không có khung |
| C→S | `live.command` | `{ live_session_id?, recording_id?, command: DeviceCommand, record?: boolean }` | ✍ vai trò; chỉ người giữ phiên/bản ghi; `record: true` chỉ với `recording_id` |
| S→C | `live.result` | `{ ok, error?: { code, message }, command_id, duration_ms }` | `re` = id của `live.command`. Mã lỗi: `not_holder`, `session_ended`, `device_offline`, `command_failed`, `forbidden` |
| S→C | `recording.step` | `{ recording_id, step: RecordingStep, popup_rule?, secret_hint?: { name } }` | sau `live.command` có `record: true`; `popup_rule` → thao tác đã làm nhưng **không** thành step (FR-015); `secret_hint` → chữ vừa gõ trùng secret `name` (không bao giờ gửi giá trị) |
| S→C | `live.ended` | `{ live_session_id?, recording_id?, reason: "idle_timeout"\|"agent_offline"\|"released"\|"replaced_by_recording" }` | |
| C→S | `live.inspect` | `{ live_session_id?, recording_id?, x, y }` | chế độ Assert: trả `live.inspected { element: ElementNode (không con), locators: Locator[], text }` — không chạm |
| ↔ | `error` | `{ code, message }` | |

`DeviceCommand` (x, y theo **pixel thiết bị** — client đã quy đổi từ khung hình, research R5):

```ts
| { kind: 'tap', x, y }            | { kind: 'long_press', x, y, ms? }
| { kind: 'swipe', from: {x,y}, to: {x,y}, ms? }
| { kind: 'type', text } | { kind: 'type', secret: 'NAME' }       // secret: server tự điền giá trị
| { kind: 'back' } | { kind: 'home' } | { kind: 'hide_keyboard' } | { kind: 'restart_app' }
```

## Quy đổi tọa độ (client)

`device_x = round(click_x_on_canvas * device_width / canvas_rendered_width)` (tương tự y), dùng `device_width/height` của **khung đang hiển thị** (edge case xoay màn hình). Sai số yêu cầu ≤ 1 % kích thước màn hình (US3 kịch bản 2).
