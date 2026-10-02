# Contract: App map — `coral/appmap@1` (§10, D24)

File `appmap/screens.json` trong kho project, kèm ảnh `appmap/snap/<screen_id>/{screen.jpg,tree.json}`. Schema và hàm fingerprint ở `packages/shared/src/appmap/`.

```json
{
  "schema": "coral/appmap@1",
  "screens": [
    {
      "id": "danh-sach-san-pham",
      "name": "Danh sách sản phẩm",
      "fingerprint": "9f2c4e71a0b3d5e8",
      "package": "com.saucelabs.mydemoapp.android",
      "activity": ".view.activities.MainActivity",
      "snapshot": "appmap/snap/danh-sach-san-pham",
      "first_seen_at": "2026-10-01T08:00:00Z",
      "seen_in": ["01a0…"]
    }
  ],
  "transitions": [
    {
      "from": "danh-sach-san-pham",
      "to": "menu",
      "action": { "action": "tap", "target": [ { "android_id": "id/menuIV" }, { "desc": "View menu" } ] },
      "seen_in": ["01a0…"]
    }
  ]
}
```

## Luật

- **Màn hình**:
  - `id`: slug ASCII của `name` (≤ 50 ký tự), trùng thì thêm `-2`, `-3`… Đặt một lần, không đổi khi gộp.
  - `name` do `describeScreen` đặt lần đầu thấy màn; người dùng sửa được bằng cách sửa file.
  - `fingerprint`: `screenFingerprint(tree, { package, activity })` — 16 ký tự hex (research R8).
  - Hai màn khác `id` không được trùng `fingerprint`.
- **Chuyển màn**: `action` là một step `coral/testcase@1` **không có** `id` và `expect`, locator lấy từ step đã ghi của trace. Trùng `(from, to, locator đầu)` thì chỉ thêm `seen_in`.
- **Gộp khi exploration kết thúc**:
  - màn hình khớp theo `fingerprint`: giữ `id`/`name`/`snapshot` cũ, thêm `seen_in`;
  - màn hình mới: thêm cùng ảnh đại diện (lần thấy đầu tiên);
  - một commit mỗi exploration.
- **`expect.screen: <id>`** của test case (§7.3) tra `fingerprint` từ file này tại commit của run. Agent nhận nó trong `job.assign.items[].screens` (contracts/agent-ws-phase3.md). `coral validate --project-root` báo `unknown_screen` khi `id` không có trong app map.
- **Giới hạn**: ≤ 500 màn hình, ≤ 5 000 chuyển màn. Vượt thì exploration không thêm màn mới (ghi `appmap_full` vào `stats`).
