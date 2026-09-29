# Contract: định dạng test case và luật popup (Phase 1)

Nguồn: SPEC §7, §9.2, §9.4, D14. Zod schema trong `packages/shared/src/testcase` và `…/popups` là bản thực thi của tài liệu này; `examples/*.yaml` phải hợp lệ.

## `coral/testcase@1`

| Trường | Kiểu | Bắt buộc | Ghi chú |
|---|---|---|---|
| `schema` | `"coral/testcase@1"` | ✔ | |
| `id` | slug `^[a-z0-9][a-z0-9-]{1,63}$` | ✔ | trùng tên file |
| `intent` | string không rỗng | ✔ | |
| `tags` | string[] | | |
| `platforms` | (`android` \| `ios`)[] không rỗng | ✔ | chỉ mở rộng thêm giá trị (D28) |
| `preconditions.app_state` | `fresh` \| `keep` | | mặc định `keep` |
| `preconditions.grant_permissions` | tên quyền §7.5 | | |
| `variables` | map `name → string` | | giá trị có thể là `${secret:NAME}` |
| `steps` | Step[] (≥ 1) | ✔ | `id` duy nhất trong file |

**Step** = `{ id, action, target?, expect?, snapshot?, …tham số theo action }` — discriminated union theo `action` (bảng §7.1):

| action | Tham số | target |
|---|---|---|
| `launch` | — | cấm |
| `tap` | — | bắt buộc |
| `long_press` | `ms` (100–10000, mặc định 1000) | bắt buộc |
| `type` | `value` (bắt buộc), `clear_first` (mặc định false) | tùy chọn |
| `clear` | — | bắt buộc |
| `swipe` | `direction` + `distance_pct` (0.1–0.95, mặc định 0.6) **hoặc** `from` + `to` (`[x,y]` 0–1); `ms` (mặc định 300) | tùy chọn |
| `scroll_to` | `direction` (mặc định down), `max_swipes` (1–50, mặc định 10) | bắt buộc |
| `back`, `hide_keyboard` | — | cấm |
| `wait` | `ms` (≤ 60000) **hoặc** `until` (Expect) | cấm |
| `assert` | — (`expect` bắt buộc) | cấm |
| `open_deeplink` | `url` | cấm |

**Locator** (đúng một khóa): `android_id` · `ios_id` · `text` · `text_contains` · `desc` · `rel: { below|above|left_of|right_of: Locator, class? }` · `class_index: { class, index ≥ 0, within?: Locator }` · `image: path` · `point_pct: [x, y]` (0–1).
`target` = Locator[] (≥ 1).

**Expect** = một điều kiện hoặc danh sách: `{ visible_text }` · `{ visible: Locator | Locator[] }` · `{ not_visible: Locator | Locator[] }` · `{ screen }`; mỗi phần tử có thể kèm `timeout_ms` (100–120000, mặc định 5000).
`visible_text` = có node hiển thị trên màn hình mà `text` chứa giá trị (chuẩn hóa khoảng trắng, phân biệt hoa/thường, không xét content-desc). Mọi điều kiện xét cả node đang bị popup che; chỉ target của thao tác mới bị kiểm tra "bị che" (SPEC §7.3, §8.4, D35).

**Nội suy**: chỉ `${secret:NAME}` (NAME `^[A-Z][A-Z0-9_]*$`) và `${var:name}` (name khai báo trong `variables`).

## Kiểm tra ngữ nghĩa (`validateTestCase`)

Lỗi (mã thoát ≠ 0):
- `var_undeclared` — `${var:x}` không có trong `variables`.
- `unknown_permission` — ngoài danh sách §7.5.
- `platform_coverage` — một `target`/`visible`/`not_visible` không còn locator nào cho một nền tảng trong `platforms`.
- `duplicate_step_id`.
- `unsupported_in_phase` — dùng `image` hoặc `expect.screen` (Phase 1).
- `point_pct_not_last` — `point_pct` không đứng cuối `target` (P2).

Cảnh báo (mã thoát 0): `no_expect_after_tap` — `tap` không có `expect` và step kế không phải `assert`.

Định dạng lỗi: `{ file, step_id?, path, code, message, line?, column? }` — `path` kiểu `steps[3].target[1].rel.below`; `line`/`column` lấy từ vị trí trong YAML.

## `coral/popups@1`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `schema` | `"coral/popups@1"` | |
| `rules[]` | `{ name, match, tap_any: string[] ≥ 1 }` | `name` duy nhất |
| `rules[].match` | ít nhất một khóa: `package`, `alert_contains`, `text_contains`, `resource_id` | mọi khóa phải cùng đúng |
| `never_tap` | string[] | so khớp không phân biệt hoa/thường, nguyên chuỗi sau chuẩn hóa khoảng trắng |

Kiểm tra: `tap_any` không được chứa nút thuộc `never_tap` (lỗi `rule_taps_never_tap`).
