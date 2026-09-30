# Quickstart: kiểm chứng Phase 1

Mỗi kịch bản ứng với một user story / tiêu chí thành công trong [spec.md](./spec.md). Chi tiết giao diện: [contracts/](./contracts/).

## 0. Chuẩn bị

- Node 24, pnpm; Docker (Postgres, Redis, MinIO); Android SDK platform-tools (`adb`).
- Emulator Android 14 (API 34, x86_64 Google APIs) đang chạy; trên WSL2 xem ROADMAP "Môi trường phát triển". `adb devices` phải thấy thiết bị.
- APK Sauce Labs My Demo App (research R15).
- `.env` ở gốc repo (từ `.env.example`), thêm:
  ```
  CORAL_JWT_SECRET=<chuỗi ngẫu nhiên ≥ 32 ký tự>
  CORAL_SEED_EMAIL=huynh@example.com
  CORAL_SEED_PASSWORD=<mật khẩu>
  CORAL_SECRET_TEST_USER=<tài khoản demo>
  CORAL_SECRET_TEST_PASSWORD=<mật khẩu demo>
  ```

```bash
pnpm install
docker compose up -d --wait
pnpm --filter @coral/server db:migrate && pnpm --filter @coral/server db:seed
```

## 1. Không cần thiết bị — CI (US1, SC-004, SC-006)

```bash
pnpm test                         # unit: schema, validate, resolver (fixtures/android), guard, runner trên FakeDriver
CORAL_INT_TESTS=1 pnpm test:int   # tích hợp: API + DB + git + S3 + dispatcher + agent giả (SC-002, SC-007, SC-009)
pnpm coral validate examples/testcase.example.yaml examples/popups.example.yaml   # exit 0
pnpm coral validate fixtures/testcases/invalid/*.yaml                            # exit 1, mỗi lỗi đúng step + trường
```

## 2. Chạy cục bộ trên emulator (US2)

```bash
pnpm coral devices
pnpm coral run fixtures/testcases/mydemo-login.yaml \
  --device emulator-5554 --app com.saucelabs.mydemoapp.android --apk ./mydemo.apk
```
Kỳ vọng: exit 0; `coral-results/<thời điểm>/mydemo-login/` có `result.json` và thư mục từng step (screenshot, tree). Sửa `android_id` của một step cho sai → step vẫn pass, `degraded: true`.

## 3. Chạy qua server — DoD (US3, SC-001, SC-002, SC-005)

```bash
pnpm dev            # server, web, agent
# Lần đầu: tạo agent token và đặt CORAL_AGENT_TOKEN trong .env, rồi khởi động lại agent
node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-login.yaml --runs 5
```
Script (qua REST, contracts/rest-api.md): đăng nhập → tạo project + app → tải build → lưu test case → chờ thiết bị `idle` → tạo 5 run **tuần tự** → với mỗi run kiểm tra `passed`, mọi step có `screenshot_url` + `tree_url` tải được (HTTP 200), thời gian run < 60 s.
Kỳ vọng: `5/5 passed`.

## 4. Popup quyền không cấp trước (US4, SC-003)

```bash
node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-camera-permission.yaml --runs 5 --expect-popup android_permission
```
Test case **không** có `grant_permissions`; `app_state: fresh`. Kỳ vọng: 5/5 pass; mỗi run có step với `popups_handled: [{ rule: "android_permission", … }]` — `--expect-popup` đánh FAIL run nào thiếu, và in các popup đã xử lý của từng run.

## 5. Secret không lộ (US5, SC-008)

```bash
node scripts/phase1-e2e.mjs --scan-secrets --run <run_id>
```
Script đọc JSON run + step qua API và tải mọi `tree.json`, `device.log` của run; đếm số lần xuất hiện giá trị `CORAL_SECRET_*` (≥ 4 ký tự). Kỳ vọng: `0 hits`. Log server/agent: chạy `pnpm dev 2>&1 | tee dev.log` trong lúc chạy mục 3, rồi `grep -cF "$CORAL_SECRET_TEST_PASSWORD" dev.log` → 0. Trong CI, `redaction.test.ts` (runner, agent) và `secret-logs.int.test.ts` (server, log mức trace) kiểm cùng điều này (T061).

## 6. Tranh chấp thiết bị và mất kết nối (SC-007, SC-009)

- Test tích hợp `runs/lease.int.test.ts`: 10 run tạo đồng thời cho một thiết bị → không có hai lease mở cùng lúc; các run chạy lần lượt.
- Thủ công: đang chạy run, tắt agent (`Ctrl+C`) → trong ≤ 60 s item đang chạy thành `error` / `DEVICE_OFFLINE`, thiết bị `offline`, lease có `release_reason = agent_offline`.

## 7. Không cần AI (SC-010)

`pnpm check:boundaries` xanh (runner, agent, cli không chạm LLM SDK) và `scripts/no-ai.test.ts` (T065) xanh — đây là bảo đảm chính, vì runner không có đường nào gọi AI. Chạy mục 3 với mạng chặn mọi tên miền nhà cung cấp AI (vẫn 5/5) chỉ là minh họa thêm, không bắt buộc.

## Checklist DoD Phase 1

Kiểm trên emulator Android 14 (`google_apis` x86_64, pixel_6) của GitHub Actions — workflow `Device` (`.github/workflows/device.yml`, `scripts/ci-device.sh`), My Demo App 2.3.0, thay cho máy Huynh (D37). Ảnh từng step: artifact `device-results` (thư mục `sheets/` có ảnh ghép).

- [x] Test đăng nhập viết tay trên app mẫu chạy qua server pass 5/5 lần liên tiếp — T056 xanh ở mọi Device run 5–11 (run 9: 5/5, 15,8–24,8 s mỗi run, 7 step)
- [x] Kết quả + screenshot từng step truy xuất được qua API — `phase1-e2e.mjs --download` tải `screenshot.png`, `tree.json` của mọi step (HTTP 200)
- [x] Unit test resolver locator với fixture cây element giả (chạy trong CI) — job `checks`
- [x] Popup quyền Android được guard xử lý khi không cấp quyền trước — T060 5/5 qua server ở mọi run, mỗi run `popups_handled: android_permission → While using the app`

Kết quả khác (Device run 8–11, 2026-09-29):

| Task | Kiểm tra | Kết quả |
|---|---|---|
| T039 | `pnpm test:device` (driver + `coral run`) | 6/6 test (run 8–11) |
| T041 | `coral run mydemo-login` cục bộ | pass mọi run, 16–30 s |
| T063 | quét secret trong dữ liệu run + log server/agent | 0 lần xuất hiện (9 tài liệu, 2 secret) |
| — | `coral run mydemo-camera-permission` cục bộ | pass ở run 5, 6, 8, 11; **lỗi ở run 9, 10**: sau `pm clear` + mở app, app đứng ở màn splash > 15 s (`EXPECT_FAILED` ở `s1`). Cùng test case qua server luôn 5/5. Đang theo dõi: CI in log activity manager của step lỗi (`scripts/ci-contact-sheet.py`). |

Những gì emulator phát hiện mà thiết bị giả bỏ sót (D36): hit-test phải theo element **nhận chạm**; thứ tự cửa sổ phải lấy từ `dumpsys window windows` (dump u2 dùng HashSet); dialog/popup là cửa sổ modal; hộp thoại ANR của app khác (launcher) phải đóng bằng Close app; u2 giải mã sai JSON không phải ASCII.
