# Contract: Tri thức project — `AGENTS.md`, skills, `mcp.yaml` (§13, §14.5)

File thuần trong kho git của project (P4). Schema ở `packages/shared` (`knowledge/`, `mcp/`); web báo lỗi khi gõ, server kiểm lại khi lưu (contracts/rest-api-phase3.md).

## `AGENTS.md`

- Markdown tự do, ≤ 64 KB; phần đưa cho AI cắt ở 16 KB (research R6).
- Gợi ý nội dung:
  - ngôn ngữ của app;
  - ngôn ngữ muốn AI viết `intent` và tên màn hình (mặc định tiếng Việt);
  - màn hình quan trọng;
  - cảnh báo.
- AI coi đây là chỉ dẫn của project. Không thay thế được kiểm tra an toàn (FR-014).

## `skills/<name>/SKILL.md` (chuẩn Agent Skills)

```markdown
---
name: login-demo-account
description: Đăng nhập My Demo App bằng tài khoản demo khi gặp màn Login
---
Mở menu → Log In. Username dùng secret TEST_USER, password dùng secret TEST_PASSWORD.
```
- Frontmatter:
  - `name` bắt buộc, = tên thư mục, khớp `^[a-z0-9][a-z0-9-]{0,63}$`;
  - `description` bắt buộc, ≤ 300 ký tự;
  - các khóa khác của chuẩn được giữ nguyên, không dùng.
- AI thấy `name` + `description` của mọi skill (tối đa 50) và đọc nội dung bằng công cụ `read_skill`.

## `skills/<name>/rules.yaml` — `coral/skill-rules@1` (tùy chọn, máy đọc)

```yaml
schema: coral/skill-rules@1
never_tap: ['Place Order', 'Đặt hàng']        # cộng thêm vào never_tap của popups.yaml (§9.4)
forbidden:                                    # element AI không được chọn (locator §7.2, không image/point_pct)
  - { android_id: 'id/checkoutBtn' }
test_data:                                    # dữ liệu AI được gõ theo tên (FR-022a)
  username: '${secret:TEST_USER}'
  password: '${secret:TEST_PASSWORD}'
  shipping_zip: '70000'
allow_submit:                                 # màn hình AI được gửi form bằng dữ liệu tự đặt
  - { screen_text: 'Sign up' }                # màn hình chứa chữ này (visible_text, §7.3)
```
- **Hợp nhất**: luật của mọi skill trong project được hợp nhất và áp dụng cho mọi exploration (không phụ thuộc skill nào được AI đọc).
- **Dữ liệu gửi AI**: giá trị `${secret:NAME}` không bao giờ gửi cho AI, AI chỉ thấy tên. Giá trị thường (không bí mật) được gửi.

## `mcp.yaml` — `coral/mcp@1` (§14.5, D29)

```yaml
schema: coral/mcp@1
servers:
  otp:
    url: https://otp.test.example.com/mcp          # chỉ http(s) — server từ xa
    headers: { Authorization: 'Bearer ${secret:OTP_TOKEN}' }
    roles: [explorer, writer]                     # vai trò được dùng (mặc định: mọi vai trò)
    tools:
      get_otp: {}                                 # công cụ chỉ đọc: chỉ cần liệt kê
      send_sms: { side_effects: true }            # có tác dụng phụ: phải bật rõ ràng
  playwright:
    command: playwright-mcp                        # stdio: chỉ khi tên có trong CORAL_MCP_STDIO_ALLOWLIST
    tools: { browser_snapshot: {} }
```
- **Allowlist**: công cụ không liệt kê trong `tools` → không bao giờ đưa cho AI; AI gọi tên đó → bị chặn, ghi `tool_calls.blocked`.
- **Tác dụng phụ**: công cụ nào mà server MCP **không** đánh dấu `annotations.readOnlyHint: true` thì coi là có tác dụng phụ. Loại này chỉ dùng được khi có `side_effects: true`; nếu thiếu, công cụ không được đưa cho AI (research R5).
- **Credential**: chỉ dạng `${secret:NAME}` trong `headers`. Chữ thường trông như token → cảnh báo `inline_credential` khi lưu.
- **Quyền sửa**: chỉ `owner`/`admin`; mỗi thay đổi ghi `audit_log`.
- **Chạy lại test**: runner và agent không bao giờ đọc file này (FR-019).
