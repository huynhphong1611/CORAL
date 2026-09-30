# Contract: locator `image` trong `coral/testcase@1` (Phase 2)

Mở rộng `specs/002-phase-1-android-runner/contracts/testcase-format.md` — chỉ **thêm** dạng mới, file cũ vẫn hợp lệ (D28).

```yaml
target:
  - android_id: 'id/menuIV'
  - desc: 'View menu'
  - image: snap/mydemo-login/s2/element.png          # dạng ngắn: đường dẫn
  - image: { path: snap/mydemo-login/s2/element.png, threshold: 0.9, screen_width: 1080 }
```

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `path` | chuỗi | đường dẫn **tính từ gốc repo project**, không có `..`, không tuyệt đối, đuôi `.png` |
| `threshold` | số 0.5–1 | độ tương đồng tối thiểu (mặc định 0.85 — SPEC §7.2) |
| `screen_width` | số nguyên > 0 | bề rộng màn hình (px) lúc cắt ảnh; runner co ảnh theo tỉ lệ bề rộng hiện tại |

Kiểm tra (`validateTestCase`, `coral validate`, lưu trên server):
- Gỡ lỗi Phase 1 "image locators are not supported yet".
- `image_path_invalid`: đường dẫn tuyệt đối, có `..`, không phải `.png`.
- `image_not_found` (khi biết gốc project: server = repo tại commit; CLI = `--project-root`): file không tồn tại.
- `image` áp dụng mọi nền tảng; `point_pct` vẫn phải đứng cuối.

Lúc chạy (research R12): thử theo thứ tự chuỗi như mọi locator; khớp ≥ `threshold` → tap tâm vùng khớp, `locator_used_index` = vị trí locator ảnh, `degraded` nếu nó không phải locator áp dụng được đầu tiên; không khớp → thử locator kế; hết → `TARGET_NOT_FOUND`. Locator ảnh **chỉ** dùng cho `target` ở Phase 2 (trong `expect` → lỗi validate `image_in_expect`).
