# Quickstart: kiểm chứng Phase 3

Mỗi kịch bản ứng với user story / tiêu chí thành công trong [spec.md](./spec.md). Giao diện: [contracts/](./contracts/). Chuẩn bị giống Phase 2 (`specs/003-phase-2-web-recorder/quickstart.md`); thêm các biến sau vào `.env` (không commit):

```bash
# Chạy không tốn tiền: provider giả có kịch bản (chỉ dev/test/CI)
CORAL_BRAIN_FAKE=1
CORAL_BRAINS_DEFAULT=examples/brains.fake.yaml     # roles.explorer/writer: { provider: fake, model: fake }

# Chạy với AI thật (máy Huynh, DoD)
CORAL_ANTHROPIC_API_KEY=…
CORAL_GEMINI_API_KEY=…
CORAL_SECRET_TEST_USER=bod@example.com
CORAL_SECRET_TEST_PASSWORD=10203040
```

## 1. Không cần thiết bị, không cần key — CI

```bash
pnpm test         # fingerprint, tuần tự hóa màn hình, kiểm an toàn, router (dự phòng, giới hạn, hỏi lại), MCP allowlist, đọc CSV/XLSX/Gherkin, lắp YAML
pnpm test:int     # exploration với agent giả + brain fake → app map commit, xác thực 2 run, import resume, quyền, cô lập tenant
pnpm test:e2e     # Playwright + thiết bị giả + brain fake: khám phá, Brain config, import CSV, MCP OTP giả; chụp ảnh giao diện
pnpm check:boundaries   # @modelcontextprotocol/* và SDK AI chỉ trong @coral/brain
```

Workflow `Device` (CI) chạy thêm exploration với brain `fake` trên My Demo App thật (không tốn tiền), kiểm `observe`/`record`/fingerprint trên cây thật.

## 2. Cấu hình bộ não (US1)

Mở `/settings/brains`, dán `examples/brains.example.yaml`, sửa rồi **Save**:
- đổi placeholder model thành model thật đang có đơn giá trong `apps/server/ai-prices.yaml`;
- đổi `writer: { provider: copilot }` sang `claude` khi chưa bật Copilot.

Kỳ vọng:
- Gõ sai provider hoặc thiếu đơn giá → lỗi đúng dòng, nút Save khóa.
- Đặt `max_cost_usd_per_day: 0.01` rồi bắt đầu khám phá → dừng với lý do `daily_limit`.
- Tab Usage khớp tổng các lời gọi.

## 3. Khám phá và sinh test (US2, US3 — SC-001)

`/projects/<id>/explore`: chọn My Demo App, build, emulator; để trống Goal; ngân sách mặc định; **Start**.

Kỳ vọng:
- Trong lúc chạy: tiến độ cập nhật ≤ 3 s mỗi bước; live view thấy app được bấm.
- Kết thúc:
  - tab App map có ≥ 5 màn hình có tên, ảnh, chuyển màn;
  - kho project có commit `appmap/…`;
  - tab Test cases có ≤ 5 test case, được xác thực 2 lần, ≥ 3 test case `active`.
- Chạy lại mỗi test case `active` 3 lần (**Run** trong editor) → 3/3 `passed`.
- Tab Trace: mở một bước thấy "What the AI saw / answered".
- Không bước nào bấm nút trong `never_tap`.

## 4. Tri thức project (US4)

Tab **Knowledge**:
- tạo skill `login-demo-account` (contracts/project-knowledge.md) với `rules.yaml` có `test_data.username: '${secret:TEST_USER}'`;
- khám phá lại.

Kỳ vọng:
- AI đăng nhập được.
- Trong trace, nội dung gửi AI chỉ có `${secret:TEST_USER}`, không có giá trị.
- Test case sinh ra dùng `${secret:…}`.

## 5. Tạo test case từ prompt (US5)

Form Explore, Goal = "Mở sản phẩm đầu tiên, thêm vào giỏ rồi thấy giỏ có 1 món".

Kỳ vọng:
- Exploration dừng `goal_reached`.
- Có một test case `source = ai_prompt`, `intent` bám mục tiêu, được xác thực.
- Goal "Thanh toán đơn hàng" (nút trong `never_tap`) → `goal_not_reached`, không có test `active`.

## 6. Import test case thủ công (US6 — SC-004)

Tab **Imports** → **Import test cases** → `fixtures/manual/mydemo-10.csv` → kiểm cột đã đoán → xem trước 10 case → **Start import**.

Kỳ vọng:
- ≥ 7 case `active`.
- Mỗi case còn lại có lý do `needs_human` / `ambiguous` / `app_mismatch` kèm ảnh/bước.
- Kho project có `imports/<job>/*.yaml`.
- Dừng server giữa chừng rồi bật lại → job tự chạy tiếp, case đã xong không làm lại.

## 7. Công cụ MCP (US7 — SC-003)

```bash
pnpm mcp:otp --port 8765 --token <token>   # get_otp (chỉ đọc), send_sms (tác dụng phụ), delete_user
```

`.env` của server: `CORAL_SECRET_OTP_TOKEN=<token>`. Tab Knowledge → `mcp.yaml`:

```yaml
schema: coral/mcp@1
servers:
  otp:
    url: http://localhost:8765/mcp
    headers:
      Authorization: 'Bearer ${secret:OTP_TOKEN}'
    tools:
      get_otp: {}
      send_sms: {}        # không có side_effects: true → AI không được gọi
```

- Thiết bị giả (`pnpm dev:fake-device`): app mẫu giả có màn "Verify Code" nhận mã `482913` (mã server giả trả). Goal: `Open the menu, then Verify Code: type the code sent by SMS, tap Verify, until "Code verified"` (e2e/us7-mcp.e2e.ts).
- My Demo App thật: không có màn OTP. Server giả trả mật khẩu demo làm "OTP", và một skill ghi "mật khẩu lấy bằng công cụ otp__get_otp". Goal: "Đăng nhập".

Kỳ vọng:
- Trace có lượt gọi `otp__get_otp` thành công; bước gõ mã mang nhãn "value from an MCP tool" (cờ `mcp_value`).
- Lời gọi `otp__send_sms` (`side_effects_disabled`) / `otp__delete_user` (`not_allowed`), nếu AI thử, bị chặn trước khi tới server và có trong `tool_calls` (kiểm bằng `apps/server/src/explorer/mcp-server.int.test.ts`).
- Test case dùng OTP ở `draft` với lý do `needs_human`.

## 8. DoD với AI thật — Huynh chạy trên máy (clarify Q1)

**Chuẩn bị**:
- thiết bị Android thật (USB debugging) hoặc emulator Android 14 có My Demo App 2.3.0, thấy được bằng `pnpm coral devices`;
- `.env`: key của các provider dùng tới (`CORAL_ANTHROPIC_API_KEY`, `CORAL_GEMINI_API_KEY`, hoặc Copilot: `CORAL_COPILOT_ENABLED=true` + `CORAL_COPILOT_TOKEN`), `CORAL_SECRET_TEST_PASSWORD=10203040` (mật khẩu demo), `CORAL_AGENT_TOKEN`;
- `docker compose up -d --wait && pnpm --filter @coral/server db:migrate && pnpm dev`;
- một file `brains.yaml` thật (mẫu: `examples/brains.example.yaml`, thay tên model; Copilot thêm `providers.copilot: { enabled: true, model: … }`).

```bash
node scripts/phase3-dod.mjs \
  --server http://localhost:3000 --email <owner> --password <…> \
  --brains my-brains.yaml --switch gemini,copilot \
  --apk <đường dẫn My Demo App 2.3.0> --device <udid> \
  --out dod-phase3/
```

Script tạo một project mới, rồi làm lần lượt và in ✅/❌ kèm chi phí (`--only sc002,sc001,…` để chạy một phần):

| Tiêu chí | Script làm gì |
|---|---|
| **SC-002** | đặt `roles.explorer` = provider thứ nhất của `--switch`, khám phá ngắn (10 bước); đổi sang provider thứ hai **chỉ qua `PUT /brains/config`**, khám phá ngắn lần nữa; kiểm mỗi exploration do đúng provider trả lời (`GET /brain-calls/:id`), in `GET /usage/ai?group=provider` |
| **SC-001** | khám phá đầy đủ (60 bước) → đếm màn hình (≥ 5) và test `active` (≥ 3) → chạy lại mỗi test `active` 3 lần qua server → 3/3 |
| **SC-003** | chạy `fixtures/mcp/otp-server.ts` (trả **tên người dùng** demo — ô mật khẩu chỉ nhận secret theo tên, FR-014), ghi `mcp.yaml` chỉ cho phép `get_otp`, thêm skill `login-otp` ("tên người dùng lấy bằng otp__get_otp", mật khẩu là test data `${secret:TEST_PASSWORD}`), chạy Goal đăng nhập → kiểm `tool_calls` có ≥ 1 lần `get_otp` `ok` và không lời gọi nào khác lọt qua. Việc chặn công cụ ngoài allowlist đã có test tích hợp tự động (`mcp-server.int.test.ts`; AI thật hiếm khi gọi tên không được đưa). Nếu tên người dùng trùng một secret của server (ví dụ `CORAL_SECRET_TEST_USER`), AI chỉ thấy `${secret:…}` (FR-013) — script ghi chú điều này; đổi `--otp-code` để thấy giá trị được gõ |
| **SC-004** | import `fixtures/manual/mydemo-10.csv` → đợi xong → ≥ 7 `active`, còn lại có lý do |
| **SC-007** | `phase1-e2e.mjs --scan-secrets --exploration … --import …` trên mọi exploration và import ở trên: lời gọi AI và công cụ, trace, app map, test case |

Thư mục `--out` chứa `report.md` (bảng kết quả, chi phí từng phần, id), `results.json` và ảnh chụp trang trong `pages/` (Playwright Chromium đăng nhập ở `--web`, mặc định `http://localhost:5173`; `--no-screenshots` để bỏ). **Gửi lại thư mục này** để đóng Phase 3. Tổng chi phí ước tính vài USD, bị chặn bởi `max_cost_usd_per_day` của file (tối đa `--max-cost-day`, mặc định 15).

Bản chạy với brain giả (không tốn tiền) là test tự động `scripts/phase3-dod.int.test.ts`.

## Checklist DoD Phase 3

- [ ] Khám phá app mẫu trong giới hạn chi phí → app map + ≥ 3 test case `active` chạy lại tất định pass (SC-001)
- [ ] Đổi brain của vai trò `explorer` chỉ bằng `brains.yaml` (SC-002)
- [ ] Vai trò AI gọi được công cụ MCP khai báo trong `mcp.yaml`; công cụ ngoài allowlist bị chặn (SC-003)
- [ ] Import 10 test case thủ công (CSV) → ≥ 7 `active`, số còn lại có lý do (SC-004)
