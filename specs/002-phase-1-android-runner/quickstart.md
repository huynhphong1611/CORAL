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
node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-camera-permission.yaml --runs 5
```
Test case **không** có `grant_permissions`; `app_state: fresh`. Kỳ vọng: 5/5 pass; mỗi run có step với `popups_handled: [{ rule: "android_permission", … }]`.

## 5. Secret không lộ (US5, SC-008)

```bash
node scripts/phase1-e2e.mjs --scan-secrets --run <run_id>
```
Tải mọi `tree.json`, `device.log`, `result.json` của run và log server/agent trong lúc chạy; đếm số lần xuất hiện giá trị `CORAL_SECRET_*`. Kỳ vọng: 0.

## 6. Tranh chấp thiết bị và mất kết nối (SC-007, SC-009)

- Test tích hợp `runs/lease.int.test.ts`: 10 run tạo đồng thời cho một thiết bị → không có hai lease mở cùng lúc; các run chạy lần lượt.
- Thủ công: đang chạy run, tắt agent (`Ctrl+C`) → trong ≤ 60 s item đang chạy thành `error` / `DEVICE_OFFLINE`, thiết bị `offline`, lease có `release_reason = agent_offline`.

## 7. Không cần AI (SC-010)

`pnpm check:boundaries` xanh (runner, agent, cli không chạm LLM SDK) và `scripts/no-ai.test.ts` (T065) xanh — đây là bảo đảm chính, vì runner không có đường nào gọi AI. Chạy mục 3 với mạng chặn mọi tên miền nhà cung cấp AI (vẫn 5/5) chỉ là minh họa thêm, không bắt buộc.

## Checklist DoD Phase 1

- [ ] Test đăng nhập viết tay trên app mẫu chạy qua server pass 5/5 lần liên tiếp
- [ ] Kết quả + screenshot từng step truy xuất được qua API
- [ ] Unit test resolver locator với fixture cây element giả (chạy trong CI)
- [ ] Popup quyền Android được guard xử lý khi không cấp quyền trước
