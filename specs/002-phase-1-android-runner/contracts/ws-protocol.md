# Contract: giao thức agent ↔ server (Phase 1)

Nguồn: SPEC §15, D18. Kết nối `WS /ws/agent` với header `Authorization: Bearer coral_agt_…`; sai/thu hồi → đóng với mã `4401`. Zod schema trong `packages/shared/src/protocol`.

## Envelope

```json
{ "v": 1, "type": "step.result", "id": "0192…", "ts": 1790604454367, "re": "0192…", "payload": { } }
```
- `id`: UUID v7; `ts`: epoch ms; `re`: bắt buộc với message trả lời.
- Message không hợp lệ → bên nhận gửi `error` `{ code: "invalid_message", message }` (có `re` nếu đọc được `id`), ghi log, **không** đóng kết nối; quá 20 message sai / phút → đóng `4400`.
- Kích thước tối đa 1 MB / message (artifact đi qua S3, không qua WS).

## Message Phase 1

| Hướng | type | payload | Trả lời |
|---|---|---|---|
| A→S | `agent.hello` | `{ agent_version, os, arch, capabilities: { platforms: ["android"], u2_jar: "0.4.0" }, devices: Device[] }` | `agent.welcome` `{ agent_id, heartbeat_ms: 15000 }` |
| A→S | `agent.heartbeat` *(bổ sung)* | `{ devices: [{ udid, status }] }` | — |
| A→S | `device.update` | `{ added: Device[], removed: [udid], changed: Device[] }` | — |
| S→A | `job.assign` | xem dưới | `job.ack` `{ run_id }` hoặc `job.reject` `{ run_id, reason }` |
| A→S | `item.result` *(bổ sung)* | `{ run_id, run_item_id, status, failure_code?, failed_step_id?, started_at, finished_at }` | — |
| A→S | `step.result` | `{ run_id, run_item_id, …StepResult }` (data-model §5) | — |
| A→S | `artifact.request_upload` | `{ run_id, run_item_id, step_index, step_id, files: [{ name, content_type, size_bytes }] }` | `artifact.upload_url` `{ uploads: [{ name, url, key, expires_at }] }` |
| A→S | `job.done` | `{ run_id, status: passed\|failed\|cancelled\|error, failure_code?, summary: { passed, failed, skipped } }` | — |
| S→A | `job.cancel` | `{ run_id, reason }` | agent kết thúc bằng `job.done` status `cancelled` |
| ↔ | `error` | `{ code, message }` | — |

`Device` = `{ udid, platform: "android", kind: "emulator"|"real", model, os_version, api_level, status: "idle"|"busy"|"unauthorized"|"offline" }` (trạng thái phía agent; trạng thái lease là của server).

### `job.assign`

```json
{
  "run_id": "…", "device_udid": "emulator-5554",
  "build": { "build_id": "…", "package": "com.saucelabs.mydemoapp.android", "download_url": "https://…", "sha256": "…" },
  "items": [ { "run_item_id": "…", "test_case_id": "…", "commit": "a1b2c3…", "yaml": "schema: coral/testcase@1\n…" } ],
  "popups_yaml": "schema: coral/popups@1\n…",
  "secrets": { "TEST_USER": "…", "TEST_PASSWORD": "…" },
  "limits": { "run_timeout_ms": 1800000, "stable_timeout_ms": 3000 }
}
```

## Thứ tự và bảo đảm

- Server chỉ gửi `job.assign` cho agent cùng tenant với run, khi lease đã được lấy; mỗi thiết bị tối đa một job.
- Agent gửi `step.result` theo đúng thứ tự step; server bỏ qua bản trùng `(run_item_id, step_index)`.
- Mất kết nối: agent giữ tối đa 200 message chưa gửi trong bộ nhớ và gửi lại khi nối lại; nếu server đã đánh dấu `DEVICE_OFFLINE` thì các message đến muộn bị bỏ qua.
- `agent.welcome`, `agent.heartbeat`, `item.result`, `error` đã được thêm vào bảng SPEC §15 (D33).
