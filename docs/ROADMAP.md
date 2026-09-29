# coral — Roadmap triển khai

Làm lần lượt từng phase. Chỉ chuyển phase khi mọi mục **Definition of Done (DoD)** đã đạt. Chi tiết kỹ thuật tham chiếu `docs/SPEC.md` (ký hiệu §, quyết định ký hiệu D). Mỗi phase là một feature Spec Kit trong `specs/` (D22).

**Phase hiện tại:** Phase 2 — bắt đầu 2026-09-29 (`specs/003-phase-2-web-recorder`). Phase 1 đạt DoD ngày 2026-09-29 (các task 🔌 chạy trên emulator Android 14 trong CI — D37). Phase 0 đạt DoD ngày 2026-09-28.

---

## Môi trường phát triển

- **App mẫu để test:** dùng một app demo mã nguồn mở có cả Android và iOS (ví dụ Sauce Labs My Demo App). Từ Phase 4 cần thêm **app fixture** tự viết (`fixtures/sample-app`) có các biến thể UI v1/v2 để kiểm tra Healer.
- **Nếu dev trên WSL2:** chạy Android emulator trên Windows host; agent trong WSL kết nối tới adb server của Windows (ví dụ đặt `ADB_SERVER_SOCKET=tcp:<windows-host-ip>:5037`, hoặc dùng mirrored networking để truy cập qua `localhost`). Kiểm tra `adb devices` từ WSL trước khi bắt đầu Phase 1.
- **iOS:** cần máy macOS + Xcode (Phase 5).

---

## Phase 0 — Khung dự án

**Spec Kit:** `specs/001-phase-0-foundation/`

**Mục tiêu:** monorepo chạy được, hạ tầng dev sẵn sàng.

- [x] Xác nhận tech stack (SPEC §19), ghi vào Decision log.
- [x] Cài Spec Kit (`.specify/`, skill `/speckit-*`), viết constitution từ P1–P6.
- [x] Monorepo pnpm + Turborepo:
  ```
  apps/server   apps/web   apps/agent
  packages/shared   (types, Zod schema: testcase, popups, WS messages)
  packages/brain    (interface + adapters, chưa implement ở phase này)
  packages/cli      (lệnh `coral`)
  fixtures/         examples/   docs/
  ```
- [x] TypeScript strict, ESLint, Prettier, Vitest.
- [x] Luật ranh giới phụ thuộc: `apps/agent` **không** được import `packages/brain` hay bất kỳ LLM SDK nào (SPEC P1, D08).
- [x] Docker Compose: postgres, redis, minio.
- [x] GitHub Actions: lint + typecheck + test.
- [x] Điền mục "Lệnh thường dùng" trong `CLAUDE.md`.

**DoD:** `pnpm install && pnpm dev` khởi động server, web, agent (khung rỗng); `pnpm test` xanh; `docker compose up -d` chạy đủ 3 dịch vụ; CI xanh.

---

## Phase 1 — Runner tất định trên Android + server tối thiểu

**Mục tiêu:** chạy một test case YAML viết tay trên Android emulator thông qua server.

- [x] Tạo `packages/runner` (D09) — runner dùng chung cho `apps/agent` và `coral run`; interface `UiDriver` + `TargetLifecycle`, lõi không import driver cụ thể (§8.1, D28).
- [x] Zod schema test case (SPEC §7, gồm §7.1 tham số action, §7.5 quyền trừu tượng) + `coral validate <file>`; `examples/*.yaml` phải validate được.
- [x] `DeviceDriver` bản Android gọi thẳng UiAutomator2 (`u2.jar`, JSON-RPC qua `adb forward` — SPEC §5.3, §8.1, D27), chuẩn hóa `ElementNode`.
- [x] Resolver chuỗi locator (§7.2): `android_id`, `text`, `text_contains`, `desc`, `rel`, `class_index`, `point_pct`. (`image` để Phase 2.)
- [x] `waitForStable`, `checkExpect`, hành động §7.1, kiểm tra element trên cùng trước khi tap (§8.4).
- [x] Chuẩn bị thiết bị: cài build, cấp quyền, tắt animation, reset app (§8.3, §9.1).
- [x] Popup guard lớp 2 với `popups.yaml` (§9.2), giới hạn 3 popup mỗi step (D25), tôn trọng `never_tap` (§9.4).
- [x] Artifact mỗi step, mã lỗi (§8.5, §8.6), đánh dấu `degraded` (§8.7); che giá trị secret (D19).
- [x] `coral run <testcase.yaml> --device <udid>` chạy cục bộ không cần server (để dev nhanh); secret đọc từ `CORAL_SECRET_<NAME>`.
- [x] Server: auth tối thiểu (1 user seed nhưng có `tenant_id` ở mọi bảng nghiệp vụ), projects, apps, builds, agents (token), devices, leases, test_cases, runs, run_items, run_steps; migration Drizzle.
- [x] Kho git project tối thiểu (§13.1, D15, D31): API thêm/sửa/xem test case và `popups.yaml` (validate khi lưu, mỗi lần sửa là một commit); run tham chiếu test case + commit.
- [x] WebSocket agent (§15): hello, device.update, job.assign/ack/done, step.result, artifact upload qua MinIO; envelope có `re` (D18).
- [x] Job queue + device lease (D16).

**DoD:** ✅ đạt 2026-09-29 trên emulator Android 14 của CI (Device run 8–11; chi tiết `specs/002-phase-1-android-runner/quickstart.md`).
- Một test case đăng nhập viết tay trên app mẫu chạy qua server → pass **5/5 lần liên tiếp**.
- Kết quả, screenshot từng step truy xuất được qua API.
- Unit test cho resolver locator (có fixture cây element giả, không cần thiết bị).
- Popup quyền Android được guard xử lý khi **không** cấp quyền trước.

---

## Phase 2 — Web UI, live view, recorder

**Mục tiêu:** thao tác và ghi test từ trình duyệt.

- [x] Web: đăng nhập, projects, devices, runs (danh sách + chi tiết step có ảnh).
- [x] Live view MVP: stream JPEG 2–5 fps qua WS (§15 `stream.*`, frame nhị phân).
- [ ] Click trên live view → quy đổi tỷ lệ → tap thật trên thiết bị (cần lease `live`).
- [ ] Recorder (§11.1): hit-test element tại điểm click → trích đủ chuỗi locator + cắt ảnh + snapshot → thêm step vào editor.
- [ ] Editor YAML có preview ảnh từng step; lưu vào git repo của project (§13).
- [ ] Locator `image`: template matching bằng OpenCV WASM trong `packages/runner` (D27).

**DoD:** ghi một flow 5 step từ web, lưu thành test case, chạy lại pass 3/3 lần.

---

## Phase 3 — Brain layer, Explorer, Test writer

**Mục tiêu:** AI khám phá app và sinh test case.

- [ ] `packages/brain`: interface (§14.1), adapter `claude`, `gemini`, `copilot` (§14.2; Copilot làm sau cùng, sau cờ — D20), Zod validate output, retry khi JSON sai.
- [ ] Router theo `brains.yaml` (§14.3), fallback, giới hạn chi phí, ghi `brain_calls`.
- [ ] MCP client (§14.5, D29): nạp `mcp.yaml` của project, allowlist tool, vòng gọi tool tối đa 5 lượt, ghi `tool_calls`; thêm MCP SDK vào kiểm tra D08.
- [ ] Bộ tuần tự hóa màn hình: danh sách element đánh số + screenshot resize.
- [ ] Prompt builder: nạp `AGENTS.md` + skill phù hợp của **đúng project** (§13).
- [ ] Explorer (§10): fingerprint màn hình (`packages/shared`, D24), app map, frontier, ngân sách, kiểm tra `never_tap`.
- [ ] Test writer (§11.2) + xác thực 2 lần liên tiếp → `active` / `draft`.
- [ ] Tạo test case từ prompt (§11.3): Explorer có mục tiêu → Test writer.
- [ ] Import test case thủ công (§11.3, D31): CSV/Excel + Gherkin → `coral/manualcase@1`; job nền có ngân sách; báo cáo đã tạo / `needs_human` / `ambiguous` / `app_mismatch`.
- [ ] Web: màn Explorations (tiến trình, app map), Brain config.

**DoD:**
- Khám phá app mẫu trong giới hạn chi phí → app map + **≥3 test case `active`** chạy lại tất định pass.
- Đổi brain của vai trò `explorer` chỉ bằng `brains.yaml`, không sửa code.
- Một vai trò AI gọi được tool từ một MCP server khai báo trong `mcp.yaml` (ví dụ server giả lập trả OTP), tool ngoài allowlist bị chặn.
- Import 10 test case thủ công (CSV) của app mẫu → ≥ 7 thành test case `active`; số còn lại có lý do rõ ràng.

---

## Phase 4 — Healer, popup AI, quy trình duyệt

**Mục tiêu:** tự chữa khi UI đổi, báo bug khi lỗi thật.

- [ ] App fixture `fixtures/sample-app` với biến thể: v2 đổi id, v3 dời nút, v4 thêm popup mới, v5 crash thật, v6 đổi hành vi (nút biến mất).
- [ ] Failure bundle (§12.1), phân loại tất định, chẩn đoán bằng Brain, verify trên thiết bị, review theo luật, tối đa 2 vòng (§12.2).
- [ ] `locator_refresh` không AI (§8.7).
- [ ] Popup resolver lớp 3 (§9.3) → đề xuất luật mới cho `popups.yaml`.
- [ ] Web: Heal review (snapshot trước/sau, diff, approve/reject), Bug list.
- [ ] Approve → commit vào git repo project; heal log.

**DoD:** với từng biến thể fixture:
- v2, v3, v4 → heal đúng, verify pass, tạo được proposal.
- v5, v6 → phân loại `bug`, **không** tạo patch.
- Chỉ số tỷ lệ heal đúng / sai được ghi nhận.

---

## Phase 5 — Multi-tenant hoàn chỉnh + iOS

**Mục tiêu:** nhiều tenant an toàn; chạy trên iOS.

- [ ] Đăng ký, mời thành viên, vai trò, API token cho CI (§5.2).
- [ ] Postgres RLS cho mọi bảng nghiệp vụ; repository có tenant scope; audit log (§17).
- [ ] Secret mã hóa envelope; prefix object storage theo tenant.
- [ ] Dọn dẹp thiết bị sau mỗi run.
- [ ] `DeviceDriver` bản iOS (XCUITest/WebDriverAgent) trên macOS: simulator trước, máy thật sau; quy đổi point ↔ pixel; alert Springboard; `simctl privacy`.

**DoD:**
- Test cô lập tự động: tenant A không đọc được dữ liệu, artifact, secret, ngữ cảnh AI của tenant B.
- Cùng một test case YAML chạy pass trên Android emulator và iOS simulator.

---

## Phase 6 — Benchmark & tích hợp CI

- [ ] Bộ benchmark brain (§14.4) + trang báo cáo.
- [ ] GitHub Action / webhook: có build mới → tự tạo run.
- [ ] coral làm MCP server `/mcp` (§14.5, D32): tool của coral + cổng tới MCP server user cấu hình (`expose: true`); API token có scope `mcp:*`.
- [ ] (Tùy chọn) Live view nâng cấp: scrcpy (Android), MJPEG WebDriverAgent (iOS).

**DoD:** báo cáo so sánh ít nhất 2 brain trên cùng bộ đề (pass rate, chi phí, thời gian, tỷ lệ heal sai); một pipeline CI kích hoạt run thành công; một AI bên ngoài (ví dụ Claude Code) chạy được test case và gọi được một tool MCP do user cấu hình qua `/mcp` của coral.

---

## Phase 7 — (Tùy chọn) Test web UI

Chỉ bắt đầu khi Phase 0–6 xong và Huynh quyết định mở rộng (SPEC §20 Q4, D28).

- [ ] Explorer web qua Playwright MCP (§14.5, D30): Playwright MCP chạy trên agent, server gọi qua kênh WS; ghi trace (snapshot + locator) cho Test writer.
- [ ] Runner web chạy lại bằng Playwright trực tiếp (không MCP, không AI): driver cài `UiDriver` + `TargetLifecycle` (browser context).
- [ ] Locator web (`testid`, `role` + name, `css`) và `platform: web` trong schema `coral/testcase@1`.
- [ ] Luật popup web: banner cookie, modal, `alert/confirm`.
- [ ] Fingerprint màn hình web (URL + cấu trúc DOM); lease slot trình duyệt trong agent.

**DoD:** Explorer + Test writer sinh được ≥3 test case `active` trên một web app mẫu; Healer xử lý đúng một biến thể đổi `testid`.
