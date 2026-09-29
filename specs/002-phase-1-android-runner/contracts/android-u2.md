# Contract: phần JSON-RPC của `u2.jar` mà driver Android dùng (D27)

Server: `u2.jar` 0.4.0 trong wheel `uiautomator2==3.7.0` (sha256 jar `0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6`). Giao thức không có tài liệu chính thức (SPEC R11) — tài liệu này là hợp đồng coral phụ thuộc vào; mỗi method dưới đây có một `*.device.test.ts` để phát hiện sớm khi đổi phiên bản jar.

## Khởi chạy

```
adb -s <udid> push u2.jar /data/local/tmp/u2.jar            # nếu md5 khác
adb -s <udid> shell CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p 9008
adb -s <udid> forward tcp:<local_port> tcp:9008
```
Lỗi khởi chạy: stdout chứa `already registered` → một client UiAutomation khác đang chạy → `DRIVER_ERROR` với hướng dẫn tắt nó. Android 14 (emulator API 34, kiểm trong CI) không báo lỗi này: server thứ hai vẫn khởi động; xung đột chỉ lộ ra khi gọi (`UiAutomation not connected`) và client khởi động lại u2 một lần như mục "Lỗi" bên dưới.

## Gọi

`POST http://127.0.0.1:<local_port>/jsonrpc/0`
```json
{ "jsonrpc": "2.0", "id": 1, "method": "dumpWindowHierarchy", "params": [false, 50] }
```
Trả `{ "result": … }` hoặc `{ "error": { "code", "message", "data" } }`. Timeout mặc định 10 s / lời gọi. `error.message` chứa `UiAutomation not connected` hoặc `DeadObjectException` → khởi động lại server một lần rồi thử lại.

## Method dùng ở Phase 1

| Method | params | Kết quả | Dùng cho |
|---|---|---|---|
| `deviceInfo` | `[]` | `{ displayWidth, displayHeight, displayRotation, sdkInt, productName, currentPackageName, … }` | `windowSize()`, kiểm tra sẵn sàng |
| `dumpWindowHierarchy` | `[compressed: false, maxDepth: 50]` | XML string (`<hierarchy rotation>` → `<node index text resource-id class package content-desc … bounds>`) | `tree()` |
| `click` | `[x, y]` hoặc `[x, y, durationMs]` | `true` | `tapAt`, `longPressAt` |
| `swipe` | `[fx, fy, tx, ty, steps]` (1 step ≈ 5 ms) | `true` | `swipe`, `scroll_to` |
| `pressKey` | `["back"]` | `true` | `back`, `hide_keyboard` (khi bàn phím mở) |
| `setText` | `[selector, text]` | `true` | `type` (selector `{ focused: true }` sau khi tap focus) |
| `clearTextField` | `[selector]` | — | `clear`, `type` với `clear_first` |

**Selector** (UiSelector của u2): `{ "mask": <bitmask>, "childOrSibling": [], "childOrSiblingSelector": [], <field>: <value> }` — bit dùng ở Phase 1: `focused` `0x020000`, `resourceId` `0x200000`, `className` `0x10`, `instance` `0x01000000`.

## Không dùng qua u2

- Screenshot: `adb exec-out screencap -p` (PNG).
- Cài đặt, quyền, xóa dữ liệu, animation, khởi chạy, deeplink, log: `adb` (research R7).
