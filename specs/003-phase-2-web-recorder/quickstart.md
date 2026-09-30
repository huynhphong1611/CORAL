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
2. Click nút menu → click "Log In" → click ô Username, gõ `bod@example.com` (trùng giá trị secret nên được ghi thành `${secret:TEST_USER}`, trang báo "The text matched secret TEST_USER") → click ô Password, chọn secret `TEST_PASSWORD` → **Type secret** → click **Login**; sau chạm chọn một đề xuất kỳ vọng (chip "Add expectation …").
3. Điền slug `recorded-login`, intent, **Preview YAML** → **Save as test case** → editor của `recorded-login` mở, ảnh snapshot cạnh từng step (US5).
4. **Run** 3 lần trên cùng emulator → 3/3 `passed`.

Kiểm tra thêm: mọi step chạm có ≥ 2 locator, locator đầu khớp đúng element lúc ghi (unit test SC-004 + đọc YAML); YAML, `snap/`, log server/agent không có giá trị mật khẩu (`scripts/phase1-e2e.mjs --scan-secrets --run <id>` và grep log — SC-008).

Tự động: `.github/workflows/device.yml` chạy đúng kịch bản này bằng Playwright trên emulator Android 14 (T046 trong tasks.md) và tải ảnh giao diện lên artifact.

**Kết quả (2026-09-30):**
- Emulator Android 14 + My Demo App 2.3.0, Device run 36672188617 (`7a2a4ba`): ghi 9 step (launch, menu, Log In, ô Username, gõ `${secret:TEST_USER}`, ô Password, gõ `${secret:TEST_PASSWORD}`, ẩn bàn phím, Login + kỳ vọng `visible_text: Sauce Labs Backpack (green)`); mọi step chạm có ≥ 2 locator (SC-004); lưu 946 ms (SC-009 ≤ 2 s); chạy lại 3/3 `passed` (SC-001); quét secret trong YAML, `snap/`, log server/agent: 0 (SC-008).
- Lần chạy đó cho thấy đề xuất kỳ vọng có thể mang giá trị secret đọc trên màn hình (`text bod@example.com`) → sửa ở `e0043d0`: server thay mọi giá trị secret trong step, đề xuất và kết quả inspect bằng `${secret:NAME}`, agent che chúng trong `tree.json` và log. Chạy lại trên emulator, Device run 36673674533 (`e0043d0`): ✅ đề xuất ở s8 thành `text “${secret:TEST_USER}”`, lưu 422 ms, chạy lại 3/3 `passed`, 0 secret trong log.
- Thiết bị giả (`pnpm test:e2e`, T045): 3/3 `passed`, lưu ~420 ms.

## 5. Editor (US5)

Mở `recorded-login`, đổi `timeout_ms` một step → **Save** → History có commit mới ở đầu. Gõ sai YAML → lỗi hiện ≤ 1 s kèm dòng, nút Save khóa. Mở cùng test case ở hai tab, lưu tab 1 rồi tab 2 → tab 2 báo "Changed by someone else" và giữ nội dung đang sửa. Bấm vị trí lỗi (`Line 15:5`) → con trỏ tới dòng đó.

Ảnh cạnh step: snapshot của Recorder (`snap/<slug>/`), không có thì ảnh step của lần chạy gần nhất, không có nữa thì "No image yet".

**Kết quả (2026-09-30, `pnpm test:e2e`, T049 `e2e/us5-editor.e2e.ts`):** test case `tour` có ảnh từ lần chạy gần nhất; đổi `timeout_ms` của step `menu` → lưu → History 2 commit, commit mới ở đầu (`current`); `timeout_ms: 5` → lỗi `Line 15:5 · menu · schema` hiện sau ~460 ms, Save khóa; hai tab → tab 2 báo xung đột, giữ nội dung, **Load latest version** nạp bản của tab 1; tổng 3 commit. Ghi xong trong Recorder mở thẳng editor, ảnh snapshot cạnh từng step (US4 E2E).

## 6. Locator ảnh (US6, SC-005)

`pnpm test` chạy bộ ảnh `fixtures/images/` (≥ 95 % tìm đúng, 0 khớp nhầm). Trên emulator: sửa test case vừa ghi cho `android_id`/`text` của một step sai đi → chạy → step `passed`, `degraded`, locator đã dùng là `image`.

**Kết quả (2026-09-30):**
- `pnpm test` (T050, `matcher.test.ts`): nút Login tìm đúng trên màn gốc và ở 10/10 chỗ đã dời dưới id mới (≥ 95 %); 0 khớp nhầm trên ≥ 12 màn không có nút (các dump Android, màn của app mẫu, bottom sheet cùng kiểu, nút cùng kiểu khác chữ); ảnh mẫu phẳng hoặc to hơn màn hình không bao giờ khớp; màn rộng 720 px cho điểm dưới ngưỡng → không khớp, không tap mù.
- Emulator Android 14, Device run 36686819869 (`4b9f137`), T053: driver cắt nút menu từ ảnh chụp thật, mở rồi đóng menu, tìm lại → score 1.00, lệch 0 px, 197 ms. `coral run` test case `mydemo-image` (`android_id` sai + locator ảnh) → s2 `passed`, `degraded`, `locator_used_index: 1`.
- Run trước đó (36684990093) cho thấy ảnh chụp giữ lại sau một step có thể trễ hơn cây element: emulator bị ANR lúc mở app, ảnh sau s1 vẫn là màn splash nên nút menu cắt ra trắng trơn — matcher từ chối (đúng, không tap mù). Test giờ cắt ảnh như Recorder (cây ổn định rồi chụp) và chỉ dùng khi tìm lại đúng chỗ trên ảnh chụp kế tiếp.

## 7. Chuẩn bị từ web (US7)

Tạo app, tải APK, tạo agent token (hiện một lần, **Copy**), đặt vào `.env` `CORAL_AGENT_TOKEN`, khởi động agent → thiết bị hiện trên `/devices`.

**Kết quả (2026-09-30, T056 `e2e/us7-setup.e2e.ts`):** từ tenant trống: tạo project → **Apps & builds** thêm My Demo App (`com.saucelabs.mydemoapp.android`) → tải APK 256 KB (thanh tiến độ, "Build 2.2.0 uploaded.") → **Devices** › **Add agent** → token hiện một lần, **Copy** vào clipboard → agent giả chạy với token đó → thiết bị `idle` hiện ngay (không tải lại), agent `online` → **Revoke** → agent `revoked`, thiết bị `offline`.

## Checklist DoD Phase 2

- [x] Ghi một flow 5 step từ web, lưu thành test case, chạy lại pass 3/3 lần (emulator CI) — US4, Device run 36673674533 (9 step, 3/3 `passed`); chạy lại trên commit cuối, Device run 36686819869 (`4b9f137`): lưu 943 ms, 3/3 `passed`, 0 secret (12 tài liệu quét + log server/agent)
- [x] Mọi job CI xanh trên commit cuối: `checks`, `infra`, `integration`, `e2e` (CI run 36686819824) và `Device` (run 36686819869)
- [x] Trình duyệt (FR-024): Chromium tự động (`pnpm test:e2e`, job `e2e` — US1–US5, US7)
- [ ] Trình duyệt (FR-024): Firefox và Edge kiểm tay — chờ Huynh (Edge dùng engine Chromium; ngoài DoD của ROADMAP)
