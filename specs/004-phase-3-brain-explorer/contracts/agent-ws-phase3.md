# Contract: Agent ↔ server — phần thêm ở Phase 3 (§15)

Envelope, `device.command` / `device.command_result` (có `re`) và các lệnh `prepare`, `record`, `restart_app` của Phase 2 giữ nguyên (`specs/003-phase-2-web-recorder/contracts/agent-ws-phase2.md`). Schema Zod ở `packages/shared/src/protocol/messages.ts`. Agent không dùng AI và không gọi MCP (P1).

## Lệnh mới: `observe` (research R7)

Server → agent, trong `device.command.command`:
```json
{
  "kind": "observe",
  "package": "com.saucelabs.mydemoapp.android",
  "popups_yaml": "…",
  "upload": { "screen": "<presigned PUT>", "ai": "<presigned PUT>", "tree": "<presigned PUT>" },
  "redact": ["<giá trị secret cần che>"]
}
```
Agent làm lần lượt:
1. Chờ màn hình ổn định (§8.3).
2. Popup guard lớp 2 xử lý tối đa 3 popup (D25). `never_tap` được tôn trọng.
3. Chụp PNG một lần, rồi tải lên:
   - `screen.jpg`: q80, đủ độ phân giải;
   - `ai.jpg`: cạnh dài ≤ 1024, q70;
   - `tree.json`: đã che các giá trị trong `redact`.

Kết quả (`device.command_result.result`, kiểm theo `commandResultSchemas.observe`):
```json
{
  "screen_width": 1080, "screen_height": 2400,
  "package": "com.saucelabs.mydemoapp.android",
  "activity": ".view.activities.MainActivity",
  "app_running": true,
  "crash": null,
  "popups_handled": ["android_permission"],
  "tree": [ /* ElementNode[] đã che secret, ≤ 2 MB */ ]
}
```
- `crash` khi app vừa crash hoặc treo: `{ "kind": "crashed" | "not_responding", "log_excerpt": "…≤ 4 KB, đã che secret…" }` — cùng cách nhận diện `APP_CRASHED` / `APP_NOT_RESPONDING` của runner.
- `activity` lấy qua `TargetLifecycle.foregroundActivity?()` (mới, `dumpsys activity`); không lấy được thì bỏ trống.
- **Lỗi**: `error.code` ∈ `device_busy` (đang chạy run) | `upload_failed` | `invalid_popups`.

## `record` dùng cho Explorer

Không đổi schema. Server gửi:
- `action.tap` / `long_press` tại **tâm bounds** của element AI chọn (theo cây của `observe` vừa rồi);
- `type` với chữ hoặc giá trị secret (kèm `secret` = tên, `redact`);
- `swipe` tính từ bounds của element cuộn và hướng;
- `back`, `hide_keyboard`.

Kết quả `record` (step có chuỗi locator, cảnh báo `never_tap`, đề xuất kỳ vọng) được lưu nguyên vào `exploration_steps.step`.

## `job.assign` (bổ sung cho `expect.screen`)

`items[]` thêm:
```json
"screens": { "danh-sach-san-pham": "9f2c4e71a0b3d5e8" }
```
- Chỉ gồm các `screen` mà test case tham chiếu, tra từ `appmap/screens.json` tại commit của item.
- Thiếu `id` → server không giao item: item `error` với thông báo `unknown_screen`.
- Runner kiểm `expect.screen` bằng `screenFingerprint` (D24) trên màn hình hiện tại, chờ tới `timeout_ms` như các kỳ vọng khác.
