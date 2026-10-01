# Contract: Test case thủ công — `coral/manualcase@1` và cách đọc file (§11.3, D31)

## Định dạng trung lập

File `imports/<job_id>/<nnn>-<slug>.yaml` trong kho project (P4). Schema ở `packages/shared/src/manualcase/schema.ts`.

```yaml
schema: coral/manualcase@1
id: TC-012                               # mã gốc nếu file nguồn có, không thì <nnn>
title: Đăng nhập bằng tài khoản hợp lệ
preconditions:
  - Ứng dụng mở ở màn danh sách sản phẩm
steps:
  - action: Mở menu, chọn Log In
    expected: Màn Login hiện ra
  - action: Nhập username bod@example.com và password 10203040, bấm Login
    expected: Quay về danh sách sản phẩm
tags: [smoke]
source: { file: manual-login.csv, row: 14 }   # hoặc { file: login.feature, line: 7 }
```
- **Bắt buộc**:
  - `title` (≤ 200 ký tự);
  - ≥ 1 step có `action`; `expected` là tùy chọn trong từng step.
- **Giữ nguyên chữ gốc**, không sửa kết quả mong đợi (P3, FR-037). Chữ trùng giá trị secret đã biết vẫn giữ trong file thủ công (đây là dữ liệu người dùng tải lên), nhưng được che trước khi gửi AI (FR-013).
- **Nối file**: `slug` sinh từ `title` (ASCII, ≤ 50 ký tự); `nnn` là số thứ tự 3 chữ số.

## CSV và Excel (`.xlsx`)

- **Đọc file**:
  - CSV: UTF-8 (có/không BOM), phân cách `,` `;` hoặc tab (tự dò), ô có xuống dòng trong dấu ngoặc.
  - Excel: sheet đầu tiên hoặc `sheet` chọn khi tải lên. Ô ngày/số được đọc thành chữ.
- **Dòng tiêu đề**: mặc định dòng 1 (`header_row`, đếm từ 0).
- **Tự đoán ánh xạ cột** theo tên (không phân biệt hoa/thường, bỏ dấu); người dùng sửa được bằng `PATCH /imports/:id`:

  | Trường | Tên cột nhận ra |
  |---|---|
  | `id` | `id`, `test id`, `case id`, `mã` |
  | `title` | `title`, `name`, `summary`, `tiêu đề`, `tên` |
  | `preconditions` | `precondition(s)`, `tiền điều kiện` |
  | `steps` | `step(s)`, `action`, `bước`, `thao tác` |
  | `expected` | `expected`, `expected result`, `kết quả`, `kết quả mong đợi` |

- **Gom nhiều dòng**: dòng có `title` trống thuộc case ở trên (mỗi dòng là một bước). Trong một ô `steps`, các dòng đánh số (`1.`, `2)`, `- `) được tách thành nhiều bước; `expected` tách theo cùng số thứ tự nếu có.
- **Lỗi** (theo dòng, không dừng cả file):
  - `missing_title`;
  - `missing_steps`;
  - `too_long` (ô > 4 000 ký tự);
  - `bad_encoding` (dòng có byte không phải UTF-8);
  - `no_mapping` (không đoán được cột tiêu đề hoặc bước: người dùng chọn cột).
- Mỗi lỗi có `code` và `message`; dòng lỗi bị bỏ, phần còn lại của file vẫn đọc.

## Gherkin (`.feature`)

- `Feature` → `tags` gồm tên feature.
- Mỗi `Scenario` → một case:
  - `title` = tên scenario;
  - `Given` → `preconditions`;
  - `When`/`And` sau When → `steps[].action`;
  - `Then`/`And` sau Then → `expected` của bước `When` gần nhất.
- `Background` → thêm vào `preconditions` của mọi scenario.
- `Scenario Outline` + `Examples` → mỗi dòng ví dụ một case; `<tên>` được thay bằng giá trị; `title` thêm ` (<giá trị cột đầu>)`.
- Lỗi cú pháp → lỗi theo `line`, các scenario hợp lệ vẫn đọc được.

## Giới hạn

- File ≤ 5 MB, ≤ 200 case mỗi job (quá → lỗi `too_many_cases`, chỉ lấy 200 đầu nếu người dùng đồng ý).
- Đọc và trả bản xem trước ≤ 10 giây cho 100 case (SC-012).
