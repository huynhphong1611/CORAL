# Quickstart: kiểm chứng Phase 2

Mỗi kịch bản ứng với user story / tiêu chí thành công trong [spec.md](./spec.md). Giao diện: [contracts/](./contracts/). Chuẩn bị giống Phase 1 (`specs/002-phase-1-android-runner/quickstart.md` §0); thêm:

```bash
pnpm install
docker compose up -d --wait && pnpm --filter @coral/server db:migrate && pnpm --filter @coral/server db:seed
pnpm dev              # server :3000, web :5173 (proxy /api, /api/ws/ui), agent
```
Mở `http://localhost:5173`, đăng nhập bằng tài khoản seed. Có thể dùng thiết bị giả lập thay emulator bằng `pnpm dev:fake-device` (agent + FakeDriver vẽ màn hình mẫu — dùng cho demo và E2E).

## 1. Không cần thiết bị — CI

```bash
pnpm test         # recorder (chọn element, chuỗi locator, đề xuất kỳ vọng), framing khung hình, image matcher, component web
pnpm test:int     # /ws/ui auth + tenant, stream qua agent giả, phiên điều khiển + lease, recording → save → commit
pnpm test:e2e     # Playwright + server + agent + FakeDriver: US1–US5 trên trình duyệt thật, chụp ảnh giao diện
```

## 2. Xem kết quả run trên web (US1)

Chạy một run (web: test case → **Run**, hoặc `scripts/phase1-e2e.mjs`). Kỳ vọng: `/runs/$id` cập nhật trực tiếp tới khi xong; mỗi step có ảnh, locator đã dùng, thời gian; step lỗi có device log. Đăng nhập bằng user của tenant khác, mở cùng URL → "Not found" (SC-007).

## 3. Live view và điều khiển (US2, US3, SC-002, SC-006)

- Mở `/devices/<emulator>` ở hai trình duyệt → cả hai thấy màn hình ≤ 3 s, ≥ 2 khung/giây (xem fps trên thanh trạng thái).
- **Take control** ở trình duyệt A → B thấy "Controlled by …", nút điều khiển bị khóa. A click nút menu của app → app mở menu, hình mới ≤ 2 s.
- Trong lúc A giữ, tạo run cho thiết bị đó → run `queued`; A bấm **Release** → run chạy.
- Không thao tác 10 phút (hoặc `CORAL_LIVE_IDLE_MS=60000` khi thử) → tự thả, A thấy thông báo.

## 4. Ghi test — DoD (US4, SC-001, SC-004, SC-008)

1. Project → **Record**: chọn app My Demo App, build, emulator → bước `s1 launch` tự có.
2. Click nút menu → click "Log In" → click ô Username, gõ `bod@example.com` (Recorder gợi ý thay bằng `${secret:TEST_USER}` → chấp nhận) → click ô Password, chọn secret `TEST_PASSWORD` → click **Login**; sau mỗi chạm chọn một đề xuất kỳ vọng (ví dụ "Products").
3. Điền slug `recorded-login`, intent, **Preview YAML** → **Save as test case** → editor mở, ảnh từng step hiện đúng.
4. **Run** 3 lần trên cùng emulator → 3/3 `passed`.

Kiểm tra thêm: mọi step chạm có ≥ 2 locator, locator đầu khớp đúng element lúc ghi (unit test SC-004 + đọc YAML); YAML, `snap/`, log server/agent không có giá trị mật khẩu (`scripts/phase1-e2e.mjs --scan-secrets --run <id>` và grep log — SC-008).

Tự động: `.github/workflows/device.yml` chạy đúng kịch bản này bằng Playwright trên emulator Android 14 (T ✍ 🔌 trong tasks.md) và tải ảnh giao diện lên artifact.

## 5. Editor (US5)

Mở `recorded-login`, đổi `timeout_ms` một step → **Save** → History có commit mới ở đầu. Gõ sai YAML → lỗi hiện ≤ 1 s kèm dòng, nút Save khóa. Mở cùng test case ở hai tab, lưu tab 1 rồi tab 2 → tab 2 báo "Changed by someone else" và giữ nội dung đang sửa.

## 6. Locator ảnh (US6, SC-005)

`pnpm test` chạy bộ ảnh `fixtures/images/` (≥ 95 % tìm đúng, 0 khớp nhầm). Trên emulator: sửa test case vừa ghi cho `android_id`/`text` của một step sai đi → chạy → step `passed`, `degraded`, locator đã dùng là `image`.

## 7. Chuẩn bị từ web (US7)

Tạo app, tải APK, tạo agent token (hiện một lần, **Copy**), đặt vào `.env` `CORAL_AGENT_TOKEN`, khởi động agent → thiết bị hiện trên `/devices`.

## Checklist DoD Phase 2

- [ ] Ghi một flow 5 step từ web, lưu thành test case, chạy lại pass 3/3 lần (emulator CI)
