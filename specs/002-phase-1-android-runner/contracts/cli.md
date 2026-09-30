# Contract: lệnh `coral` (Phase 1)

## `coral validate <file…>`

Kiểm tra file `coral/testcase@1` hoặc `coral/popups@1` (nhận theo trường `schema`).

| Tùy chọn | Ý nghĩa |
|---|---|
| `--format text\|json` | mặc định `text` |

Đầu ra `text`: mỗi lỗi một dòng `file:line:column  step_id  path  code  message`; cuối cùng `N files, E errors, W warnings`.
Đầu ra `json`: `{ files: [{ file, valid, errors: [...], warnings: [...] }] }` (định dạng lỗi: contracts/testcase-format.md).
Mã thoát: `0` hợp lệ (có thể có cảnh báo), `1` có lỗi, `2` lỗi dùng lệnh/đọc file.

## `coral devices`

Liệt kê thiết bị Android mà máy này thấy (`adb devices -l` + model, phiên bản, API level). Mã thoát `2` nếu không tìm thấy `adb`.

## `coral run <testcase.yaml…> --device <udid>`

Chạy cục bộ, không cần server, không AI.

| Tùy chọn | Ý nghĩa | Mặc định |
|---|---|---|
| `--device <udid>` | thiết bị (bắt buộc nếu có > 1 thiết bị) | thiết bị duy nhất |
| `--app <package>` | package app đang test | bắt buộc |
| `--apk <path>` | cài/cập nhật build trước khi chạy | không cài |
| `--popups <file>` | luật popup | bộ luật mặc định đóng gói sẵn (bản sao `examples/popups.example.yaml`) |
| `--out <dir>` | thư mục kết quả | `./coral-results/<thời điểm>/` |
| `--stable-timeout <ms>` | §8.3 | 3000 |
| `--format text\|json` | | text |

Secret: `${secret:NAME}` đọc từ biến môi trường `CORAL_SECRET_<NAME>` (có thể đặt trong `.env`); thiếu → mã thoát `2` trước khi đụng thiết bị.

Thư mục kết quả:
```
<out>/<slug>/result.json                    # { status, failure_code?, steps: StepResult[] } đã che secret
<out>/<slug>/<step_index>-<step_id>/screenshot.png | tree.json | device.log
```
Mã thoát: `0` mọi test case pass, `1` có test case fail, `2` lỗi cấu hình/thiết bị/driver.
