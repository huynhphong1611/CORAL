# Contract: giao thức agent ↔ server — phần thêm ở Phase 2

Bổ sung cho `specs/002-phase-1-android-runner/contracts/ws-protocol.md` (envelope, xác thực, giới hạn giữ nguyên). Các `type` dưới đây đã có tên trong bảng SPEC §15; Phase 2 định nghĩa payload. Zod ở `packages/shared/src/protocol/messages.ts`.

## Live view

| Hướng | type | payload |
|---|---|---|
| S→A | `stream.start` | `{ udid, fps: 2–5 (mặc định 4), max_edge: 1280, quality: 30–90 (mặc định 60) }` |
| S→A | `stream.stop` | `{ udid }` |
| A→S | *(binary)* `stream.frame` | header `{ type: "stream.frame", udid, seq, ts, width, height, device_width, device_height, rotation, mime: "image/jpeg"\|"image/png" }` + ảnh — framing `[uint32 BE độ dài header][header JSON][ảnh]`, tối đa 2 MB/khung |

- Agent: một khung một lúc, không xếp hàng khung cũ (research R4); `takeScreenshot(scale, quality)` của u2, fallback `screencap -p` (mime PNG).
- `stream.start` lặp lại cho cùng thiết bị = cập nhật tham số; thiết bị biến mất → agent ngừng và báo `device.update` như Phase 1.
- Stream chạy được cả khi thiết bị đang chạy job (chỉ đọc).

## Lệnh điều khiển, ghi và xem element

| Hướng | type | payload | Trả lời |
|---|---|---|---|
| S→A | `device.command` | `{ command_id, udid, command }` | `device.command_result` (`re` bắt buộc) |
| A→S | `device.command_result` | `{ command_id, ok, error?: { code, message }, result? }` | — |

`command` (server chỉ gửi khi có lease `live`/`recording` của đúng thiết bị — research R7):

| kind | tham số | `result` |
|---|---|---|
| `tap`, `long_press`, `swipe`, `back`, `home`, `hide_keyboard` | như `DeviceCommand` (contracts/ui-ws.md) | — |
| `type` | `{ text }` (giá trị thật; nếu là secret thì server đã thay tên bằng giá trị) + `redact: string[]` | — |
| `restart_app` | `{ package }` | — |
| `prepare` | `{ package, build?: { download_url, sha256 }, app_state: "fresh" \| "keep", popups_yaml }` | `{ snapshot_uploads }` như `record` |
| `record` | `{ action: DeviceCommand, package, popups_yaml, upload: { screen, tree, element } }` — `upload` là presigned PUT do server sinh (T062) | `{ step: Step, suggestions: Expect[], warnings: string[], popup_rule?: string, screen_width, screen_height, target_password?: boolean }` |
| `inspect` | `{ x, y }` | `{ element, locators, text }` (research R8 bước 1–3, không chạm) |

`record` trên agent (packages/runner `core/recorder`, research R8–R9): cây ổn định trước → chọn element đích + chuỗi locator → chụp `screen.jpg`, cắt `element.png`, `tree.json` (đã che secret) → upload → thực hiện thao tác (tap vào tâm element đích) → chờ ổn định → đề xuất kỳ vọng từ cây trước/sau → trả kết quả. Thao tác vào popup khớp luật: vẫn làm, `popup_rule` được đặt, không tạo `step`.

## `job.assign` (bổ sung)

`items[].assets: [{ path, sha256, download_url }]` — ảnh mà locator `image` của test case tham chiếu (research R12); agent tải về cache theo sha256 trước khi chạy item, sai sha256 → item `error` `DRIVER_ERROR`.
