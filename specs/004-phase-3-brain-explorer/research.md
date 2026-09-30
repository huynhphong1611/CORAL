# Research: Phase 3 — Brain layer, Explorer, Test writer

**Feature**: `004-phase-3-brain-explorer` · **Date**: 2026-09-30 · Nguồn: spec.md (kèm 7 câu làm rõ), SPEC §6, §9.4, §10, §11, §13, §14, §15–§18, D08, D13, D16, D19, D20, D24, D29, D31, D36–D40

Mỗi mục: **Decision** / **Rationale** / **Alternatives**. Phiên bản thư viện tra trên npm ngày 2026-09-30.

## R1. Chia gói và luồng phụ thuộc

- **Decision**:
  - `packages/shared` (thuần, chạy cả trình duyệt): Zod schema của mọi định dạng mới:
    - `coral/brains@1` (`brains.yaml`), `coral/mcp@1` (`mcp.yaml`), `coral/skill-rules@1` (`skills/<name>/rules.yaml`), frontmatter `SKILL.md`;
    - `coral/manualcase@1`, `coral/appmap@1`;
    - kiểu quyết định của AI (`ai/decisions.ts`);
    - hàm **fingerprint màn hình** (D24).

    Web dùng các schema này để báo lỗi ngay khi gõ (như `validateTestCaseSource` ở Phase 2).
  - `packages/brain`: giao diện `Brain` (§14.1), prompt của từng vai trò (chữ trung lập provider), adapter `claude` / `gemini` / `copilot` / `fake`, router (vai trò → provider, dự phòng, giới hạn chi phí), vòng gọi công cụ và **MCP client**. Đây là gói **duy nhất** phụ thuộc LLM SDK và MCP SDK.
  - `apps/server`: dịch vụ Explorer, Test writer, xác thực, import, tri thức project, cấu hình bộ não, nhật ký chi phí. Server được import hàm thuần của `@coral/runner` (resolver, hit-test, `checkExpect` trên cây tĩnh) — SPEC §4.2 đã vẽ `apps/server ──▶ packages/runner`, hiện chưa dùng.
  - `apps/agent`: thêm lệnh `observe` (R7). Không AI, không MCP.
  - `scripts/boundaries.mjs`: thêm `@modelcontextprotocol/*` vào danh sách chỉ `@coral/brain` được phụ thuộc (§14.5 "bổ sung vào kiểm tra D08 ở Phase 3"). Kiểm cả phụ thuộc bắc cầu qua lockfile như hiện nay.
- **Rationale**: P1 giữ được bằng máy kiểm (D08). Web cần schema để lint YAML/Markdown mà không import brain. Server cần đúng logic chọn element và kiểm kỳ vọng mà agent dùng, để bản nháp test case khớp lúc chạy lại.
- **Alternatives**:
  - Viết lại resolver/kiểm kỳ vọng trong server: hai bản dễ lệch.
  - Chuyển resolver sang shared: tái cấu trúc lớn không cần thiết; runner không phụ thuộc LLM nên server dùng được.

## R2. Adapter của provider

- **Decision**: mỗi adapter cài **một** hàm cấp thấp. Mọi phương thức của `Brain` (`describeScreen`, `nextAction`, `writeTest`) được dựng chung trên hàm này (R3), nên thêm provider chỉ cần một file.
  ```
  chat({ system, messages, images, tools, output_schema }) → { text | tool_calls, usage }
  ```
  - **`claude`** — `@anthropic-ai/sdk` 0.129 (MIT):
    - Gọi `messages.create`: ảnh là khối `image` base64; công cụ khai báo `strict: true`; `tool_choice: auto` (các model mới trả 400 với `any`/`tool`); câu trả lời cuối ép JSON bằng `output_config.format` (JSON Schema sinh từ Zod bằng `z.toJSONSchema`).
    - Phần hệ thống ổn định (vai trò + `AGENTS.md` + danh sách skill) để trước, gắn `cache_control` để cache prompt.
    - Chi phí đọc từ `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
    - `stop_reason: refusal` hoặc `max_tokens` → lời gọi lỗi (sang dự phòng).
    - Lỗi có kiểu (`RateLimitError`, `APIConnectionError`, `AuthenticationError`…) được phân loại để router quyết định dự phòng.
    - Tên model và `effort` (tùy chọn) lấy từ cấu hình.
  - **`gemini`** — `@google/genai` 2.24 (Apache-2.0):
    - Gọi `ai.models.generateContent`: ảnh `inlineData`; công cụ `functionDeclarations`; JSON bằng `responseMimeType: application/json` + JSON Schema.
    - Chi phí đọc từ `usageMetadata`.
    - Model nào không nhận JSON mode cùng lúc với function calling thì adapter chạy **hai pha**: các lượt công cụ không bật JSON, rồi một lời gọi cuối bật JSON và không có công cụ.
    - Tọa độ chuẩn hóa 0–1000 (nếu có) quy về `point_pct`.
  - **`copilot`** — `@github/copilot-sdk` 1.0 (MIT):
    - SDK điều khiển **Copilot CLI** qua JSON-RPC, nên server cần cài CLI `copilot` và token Copilot của tenant.
    - Bật bằng biến môi trường `CORAL_COPILOT_ENABLED=1` **và** cờ trong cấu hình tenant (FR-009).
    - Vì chưa chắc Copilot nhận ảnh, adapter khai báo `vision: false`, chỉ dùng được cho vai trò không cần ảnh (`writer`). Router từ chối cấu hình gán Copilot cho vai trò cần ảnh.
    - Làm sau cùng. Nếu thử nghiệm thấy không dùng được trong server thì để tắt và ghi lại (R7 SPEC).
  - **`fake`** — adapter có kịch bản cho unit, tích hợp, E2E và workflow Device, không gọi mạng:
    - `explorer`: chọn element chưa thử đầu tiên; Back khi hết.
    - `writer`: mỗi đoạn giữa hai lần mở app thành một flow; lấy đề xuất kỳ vọng của Recorder.
    - `describeScreen`: đặt tên theo chữ lớn nhất trên màn hình.

    Chỉ nhận khi server chạy với `CORAL_BRAIN_FAKE=1`; không bao giờ xuất hiện với tenant thật.
- **Rationale**: provider khác nhau ở khuôn gọi; phần khó (prompt, kiểm định dạng, hỏi lại, vòng công cụ, chi phí) viết một lần. Adapter giả giúp CI tất định và không tốn tiền (clarify Q1: CI không có key AI).
- **Alternatives**:
  - Thư viện trừu tượng nhiều provider (`ai`/`@ai-sdk/*`): thêm một lớp phụ thuộc, khó kiểm soát cache prompt và cách tính token của từng hãng; đã nằm trong danh sách cấm ngoài `brain`.
  - Dùng tính năng MCP connector riêng của từng hãng: trái §14.5 (router tự làm MCP client).

## R3. Câu trả lời có cấu trúc, hỏi lại và vòng công cụ

- **Decision**:
  - Mỗi phương thức `Brain` có một schema Zod cho câu trả lời (`packages/shared/src/ai/decisions.ts`, contracts/brain.md). JSON Schema gửi cho provider sinh từ chính schema đó.
  - Dù provider đã "đảm bảo" định dạng, server **luôn** kiểm lại bằng Zod (FR-002).
  - Sai → gửi lại hội thoại kèm lỗi Zod rút gọn, tối đa 2 lần. Vẫn sai → `BrainOutputError`: lời gọi thất bại, không hành động.
  - Vòng công cụ: mỗi lượt, provider có thể trả lời bằng lời gọi công cụ thay vì câu trả lời cuối. Router thực thi công cụ (MCP hoặc công cụ nội bộ `read_skill`, R6) rồi gửi kết quả lại.
  - Tối đa **5 lượt công cụ** mỗi quyết định. Tới lượt 5, lời gọi kế tiếp gửi kèm chỉ dẫn "trả quyết định cuối" và không còn công cụ (FR-017).
  - Các lần hỏi lại và các lượt công cụ đều ghi vào nội dung lời gọi (FR-006a) và tính chi phí.
- **Rationale**: không tin output của LLM (constitution: Zod cho mọi output của LLM). Một vòng chung cho mọi adapter.
- **Alternatives**: ép gọi công cụ `submit_decision` bằng `tool_choice` bắt buộc — các model Claude mới từ chối kiểu này, và không trung lập provider.

## R4. Router: định tuyến theo vai trò, dự phòng, giới hạn chi phí

- **Decision**:
  - **Định tuyến và dự phòng**:
    - Vai trò của Phase 3: `explorer`, `writer`. Router tra `roles.<vai trò>` trong cấu hình tenant (`tenants.settings.brains`, D20).
    - Lỗi có thể thử nơi khác (hết giờ 60 s, 429, 5xx, lỗi mạng, lỗi xác thực key, `refusal`, câu trả lời sai sau 2 lần hỏi lại) → thử lần lượt `fallback`, bỏ qua provider trùng. Mỗi lần thử là một dòng `brain_calls`; lần cuối ghi provider đã trả lời.
    - Lỗi do dữ liệu của mình (400 vì yêu cầu sai) → không dự phòng, báo lỗi.
  - **Đơn giá và giới hạn chi phí**:
    - Đơn giá theo model là dữ liệu: `apps/server/ai-prices.yaml` (nền tảng, đường dẫn đổi bằng `CORAL_AI_PRICES`) và `prices:` trong `brains.yaml` (tenant ghi đè). Model không có đơn giá → cấu hình bị từ chối khi lưu, và lời gọi bị chặn nếu đơn giá biến mất (FR-006).
    - Trước mỗi lời gọi, router hỏi `limits`: chi phí tenant trong ngày UTC (tổng `brain_calls.cost_usd`) < `max_cost_usd_per_day`, và chi phí của hoạt động < ngân sách của nó. Không đạt → `BudgetExceededError` (FR-007).
    - Lời gọi đang chạy không bị cắt. Nhiều hoạt động song song của cùng tenant có thể vượt giới hạn ngày tối đa bằng số lời gọi đang chạy, chấp nhận được. Mỗi hoạt động chạy tuần tự nên không vượt ngân sách của nó quá một lời gọi (SC-009).
  - **Key**:
    - Key của nền tảng từ biến môi trường server (`CORAL_ANTHROPIC_API_KEY`, `CORAL_GEMINI_API_KEY`).
    - Key riêng của tenant: `api_key_secret: NAME` trong `brains.yaml` → `CORAL_SECRET_<NAME>` (chỉ dev, D19; bảng `secrets` ở Phase 5).
    - Key không bao giờ được ghi log hay trả qua API (FR-008).
  - **Không có cấu hình**: tenant chưa có cấu hình dùng cấu hình mặc định của nền tảng (`CORAL_BRAINS_DEFAULT`, đường dẫn tới một `brains.yaml`). Không có cả hai → API AI trả `409 brains_not_configured`.
- **Rationale**: đúng §14.3/§18; giới hạn luôn có hiệu lực vì chi phí tính trước khi gọi.
- **Alternatives**:
  - Giữ chỗ chi phí tối đa (`max_tokens` × đơn giá) trước mỗi lời gọi: chặn sớm quá mức với model đắt.
  - Đếm chi phí trong Redis: thêm một nguồn sự thật; Postgres đủ nhanh ở quy mô này.

## R5. MCP client (§14.5, D29)

- **Decision**: `@modelcontextprotocol/sdk` 1.31 (MIT) trong `packages/brain`.
  - **Kết nối**:
    - `Client` + `StreamableHTTPClientTransport` tới server **từ xa** khai báo trong `mcp.yaml`.
    - Header lấy từ `${secret:NAME}`, giải bằng cùng nguồn secret của server (D19).
    - Mỗi hoạt động (exploration, job import) mở kết nối khi cần lần đầu và đóng khi xong.
  - **Công cụ đưa cho AI**:
    - `listTools()` rồi lọc theo `tools:` của `mcp.yaml`. Công cụ không có `annotations.readOnlyHint: true` coi là **có tác dụng phụ**, chỉ được đưa cho AI khi mục của nó có `side_effects: true` (FR-016).
    - Tên công cụ đưa cho AI là `<server>__<tool>`; schema đầu vào lấy từ MCP.
  - **Thực thi**:
    - Router kiểm lại allowlist khi AI gọi (AI có thể bịa tên). Bị chặn → trả cho AI `{ error: "not_allowed" }` và ghi `tool_calls.blocked = true`.
    - Hết giờ 20 s. Kết quả chữ cắt ở 8 KB trước khi đưa AI. Giá trị secret trong kết quả bị thay bằng `${secret:NAME}` (FR-013).
  - **Nhật ký**: mỗi lần gọi ghi `tool_calls` (tham số đã che secret, `ok`, `latency_ms`, `blocked`, `brain_call_id`) — FR-018.
  - **Server cục bộ (stdio)**: chỉ nhận khi tên có trong `CORAL_MCP_STDIO_ALLOWLIST` (mặc định rỗng). Phase 3 không cần.
  - **Kiểm thử**: MCP server giả `fixtures/mcp/otp-server.ts` (McpServer + Streamable HTTP của cùng SDK) có `get_otp` (readOnly), `send_sms` (có tác dụng phụ) và `delete_user` (không trong allowlist) cho US7 và SC-003.
- **Rationale**: trung lập provider — adapter chỉ thấy "function" (R3). Nhận diện tác dụng phụ bằng annotation chuẩn của MCP, mặc định an toàn khi thiếu.
- **Alternatives**: tin khai báo của `mcp.yaml` là đủ, không kiểm lại lúc gọi — AI có thể gọi tên ngoài danh sách.

## R6. Ngữ cảnh gửi cho AI và prompt builder (§13, FR-011–FR-015)

- **Decision**:
  - **Màn hình** (bộ tuần tự hóa, `apps/server/src/ai/screen.ts`):
    - Từ cây đã che secret, lấy các element **thao tác được**: visible, `clickable`/`long_clickable`/`scrollable` hoặc ô nhập; tâm nhận chạm đúng element theo hit-test D36 (`checkHit` của runner); thuộc cửa sổ của app hoặc popup.
    - Loại element thuộc `never_tap` (của `popups.yaml` và skill) và element bị skill cấm.
    - Đánh số `#1…#N` theo thứ tự đọc (trên → dưới, trái → phải), tối đa 80.
    - Mỗi dòng: `#n class id="…" text="…" desc="…" [x,y,w,h] flags`. `flags` ∈ `new | tried | dead | field | password | search | scroll`.
    - Kèm ảnh chụp thu nhỏ (cạnh dài ≤ 1024 px, JPEG q70 — R7), tên màn hình trong app map (nếu đã biết), kích thước màn hình.
  - **Ngữ cảnh ổn định**, đặt đầu để cache prompt:
    1. Chỉ dẫn của vai trò (tiếng Anh, trong `packages/brain/src/prompts/`).
    2. `AGENTS.md` của project (cắt ở 16 KB).
    3. Danh sách skill (tên + mô tả, tối đa 50).
    4. Dữ liệu thử có tên (`rules.yaml`: tên + giá trị không bí mật; secret chỉ ghi tên).
  - **Nạp skill dần**: nội dung một skill nạp bằng công cụ nội bộ `read_skill(name)`, tính vào 5 lượt công cụ.
  - **Ngữ cảnh thay đổi**, đặt sau: mục tiêu, lịch sử 10 bước gần nhất (thao tác + tên màn hình), thống kê ngân sách, màn hình hiện tại.
  - **Chỉ từ project đang chạy** (FR-012): prompt builder nhận `projectId` và chỉ đọc repo của project đó; không có đường nào nạp dữ liệu project khác.
  - **Secret** (FR-013): chữ trùng giá trị secret đã biết (secret của test case, tài khoản trong `rules.yaml`, credential MCP) được thay trong danh sách element, lịch sử và kết quả công cụ bằng `Redactor` (Phase 1). AI gõ secret bằng `{ "type": "#3", "secret": "TEST_USER" }`.
- **Rationale**:
  - Danh sách đánh số đúng §10/§14.1. Ảnh nhỏ giảm token (khoảng 1–1,6 nghìn token/ảnh).
  - Nạp dần giữ ngữ cảnh gọn và đúng tinh thần `SKILL.md`.
  - Nội dung ổn định đặt trước để cache (R2).
- **Alternatives**: so khớp mô tả skill bằng từ khóa rồi nhét cả nội dung — dễ sót hoặc thừa; để AI tự quyết đọc skill nào là cách chuẩn của Agent Skills.

## R7. Lệnh agent cho Explorer: dùng lại Recorder + thêm `observe`

- **Decision**: Explorer điều khiển thiết bị từng bước bằng lệnh agent của Phase 2 (`prepare`, `record`, `restart_app`), cộng một lệnh mới.
  - **Lệnh mới `observe { package, popups_yaml, upload: { screen, ai, tree }, redact }`**:
    1. Chờ màn hình ổn định.
    2. Popup guard lớp 2 xử lý tối đa 3 popup như sau `launch` (D25).
    3. Chụp PNG một lần, rồi tải lên:
       - `screen.jpg`: q80, đủ độ phân giải, cho trace và app map;
       - `ai.jpg`: cạnh dài ≤ 1024, q70 — thu nhỏ trong `packages/runner/src/core/image/`, JS thuần như `crop.ts`;
       - `tree.json`: đã che secret.
    4. Trả về trong kết quả:
       - kích thước màn hình;
       - `package` và `activity` đang ở trên cùng (`dumpsys`, qua `foregroundActivity?()` mới của `TargetLifecycle`);
       - `app_running`;
       - `crash?`: `{ kind: crashed | not_responding, log_excerpt }` — cùng cách nhận diện `APP_CRASHED`/`APP_NOT_RESPONDING` của runner;
       - `popups_handled`;
       - **cây** đã che secret (inline, ≤ 2 MB).
  - **Thao tác của AI**:
    - `tap`/`long_press #n` → `record` tại tâm element: agent trích chuỗi locator từ cây (Recorder, không AI), cắt ảnh, lưu snapshot, chạm.
    - `type #n` → hai lệnh: `record(tap #n)` rồi `record(type)` vào ô đang focus. Test writer gộp thành một step `type` có `target` (R12).
    - `swipe` (hướng + element cuộn), `back`, `hide_keyboard` → `record` tương ứng.
    - Mở lại app → `restart_app`, hoặc `prepare` khi cần trạng thái sạch.
  - Lệnh chạy trên thiết bị đang giữ lease `exploration` (D16), qua cùng `AgentCommands` của Phase 2.
- **Rationale**:
  - Chuỗi locator của trace do đúng mã Recorder tạo, nên test case sinh ra đạt chuẩn SC-004 của Phase 2 (P2, SC-006).
  - `observe` tách "nhìn" khỏi "làm", để server có cây và ảnh cho AI sau mỗi thao tác.
  - Popup quen do luật lo, AI không tốn lượt.
- **Alternatives**:
  - Server gọi thẳng u2 qua agent từng RPC: nhiều vòng mạng, lặp lại logic của runner.
  - Server tải `tree.json` từ S3 thay vì nhận inline: thêm một vòng tải cho mỗi bước.

## R8. Fingerprint màn hình (D24, FR-023)

- **Decision**: `screenFingerprint(tree, { package, activity? })` trong `packages/shared/src/appmap/fingerprint.ts`:
  1. Chỉ lấy cửa sổ của app (bỏ status bar, bàn phím, cửa sổ hệ thống).
  2. Duyệt cây. Với container danh sách (`RecyclerView`, `ListView`, `GridView`, `ScrollView` có ≥ 3 con cùng cấu trúc), chỉ giữ **con đầu**.
  3. Lấy tập các cặp `(tên class ngắn, platform_id)` của element có id hoặc bấm được; bỏ chữ, bỏ bounds.
  4. Sắp xếp, nối với `package` và `activity` (nếu có), băm SHA-256, lấy 16 ký tự hex đầu.

  Runner hỗ trợ kỳ vọng `screen: <screen_id>`:
  - `job.assign.items[].screens = { <screen_id>: <fingerprint> }` lấy từ `appmap/screens.json` tại commit của item (contracts/agent-ws-phase3.md);
  - runner so fingerprint của màn hình hiện tại, chờ như các kỳ vọng khác;
  - bỏ lỗi "expect.screen is not supported in Phase 1".
- **Rationale**:
  - Đúng §10: bỏ chữ và phần tử lặp nên danh sách dài hay giờ đổi không sinh màn mới (US2 kịch bản 4).
  - Một hàm dùng chung cho Explorer và runner (D24). Thứ tự và độ phân giải không ảnh hưởng.
- **Alternatives**: băm ảnh chụp (perceptual hash) — nhạy với dữ liệu động, không dùng được cho `expect.screen` khi app đổi màu.

## R9. Vòng khám phá và chiến lược (§10, FR-020–FR-027)

- **Decision**: `ExplorationService` trong server chạy exploration như một tác vụ bất đồng bộ trong tiến trình (giống `RecordingService`). Trạng thái được ghi DB **sau mỗi bước** (`explorations`, `exploration_steps`).
  - **Bắt đầu**:
    - lấy lease `exploration` (409 `device_busy` như Phase 2);
    - `prepare` (cài build nếu khác, `pm clear`, mở app);
    - trạng thái `running`.
  - **Mỗi bước**:
    1. `observe`.
    2. Tính fingerprint → màn hình trong app map (mới thì gọi `describeScreen` để đặt tên, trùng tên thì thêm hậu tố).
    3. Kiểm crash (R9a).
    4. Tuần tự hóa (R6).
    5. `nextAction`.
    6. Kiểm an toàn (R10).
    7. Thực hiện (R7).
    8. Ghi bước.
  - **Theo dõi phạm vi**:
    - Frontier: mỗi màn hình giữ tập element đã thử (khóa = locator đầu của chuỗi) và element "không có tác dụng" (thao tác xong fingerprint không đổi và cây không đổi) — FR-024.
    - Độ sâu = số chuyển màn từ lần mở app gần nhất.
    - Kẹt = 3 thao tác liên tiếp không đổi màn, hoặc foreground không phải app, hoặc app không chạy → Back một lần; vẫn kẹt → `restart_app`.
  - **Dừng** khi chạm một trong các điều kiện: `max_steps` (thao tác + lần bị từ chối), `max_depth` (vượt thì AI chỉ còn Back), `max_minutes`, `max_cost_usd`, `goal_reached` (AI trả `done` ở chế độ có mục tiêu), người dùng dừng, thiết bị mất kết nối.
  - **Kết thúc** (bất kỳ lý do):
    1. Ghi app map (R11).
    2. Thả lease.
    3. Chạy Test writer (R12) rồi xác thực (R13).
  - **Server khởi động lại** (clarify 5): lúc khởi động, exploration đang `running`/`writing` chuyển `interrupted`. App map được ghi từ các bước đã lưu, lease được sweeper thả, không viết test.
  - **R9a — phát hiện crash**:
    - `observe.crash` hoặc `app_running = false` ngay sau thao tác → bản ghi `findings` (thao tác cuối, `screen.jpg`, đoạn log);
    - `restart_app`, tiếp tục (FR-026).
- **Rationale**: tuần tự trên một thiết bị, trạng thái nằm trong phiên (màn hình hiện tại) → không cần hàng đợi bền. Ghi DB từng bước để tiến độ web và khôi phục app map đều đọc được.
- **Alternatives**: BullMQ job cho exploration — không chạy tiếp được sau restart (thiết bị đã khác trạng thái), thêm độ phức tạp vô ích.

## R10. Kiểm tra an toàn (FR-022, FR-022a, P6)

- **Decision**: hàm thuần `checkDecision(decision, screen, context)` trong `apps/server/src/explorer/safety.ts`. Chạy **sau** AI, trên danh sách element gốc (không phải chữ AI trả).
  - **Từ chối khi** element không tồn tại, không nhận chạm (D36), thuộc `never_tap` (§9.4, chuẩn hóa như popup guard), bị skill cấm, hoặc là `point_pct` trong khi danh sách có element.
  - **Dữ liệu gõ** (FR-022a), một trong hai:
    - `secret: NAME` / `test_data: NAME` có trong `rules.yaml`;
    - chữ tự đặt ≤ 64 ký tự, không trùng giá trị secret đã biết.
  - **Chặn gửi form bằng dữ liệu tự đặt**:
    - màn hình (theo fingerprint) đã nhận chữ tự đặt → mọi chạm vào element không phải ô nhập bị từ chối, trừ hai ngoại lệ;
    - ngoại lệ 1: ô đã gõ là **ô tìm kiếm/lọc** — class `SearchView`/`SearchAutoComplete`, hoặc id/hint/desc chứa `search|tìm|lọc|filter`;
    - ngoại lệ 2: `rules.yaml` có `allow_submit` khớp màn hình (chứa chữ `screen_text`);
    - Back luôn được.
  - **Mọi lần từ chối** thành `exploration_steps.status = refused` kèm `refusal` ∈ `not_found | not_actionable | never_tap | skill_forbidden | point_pct_not_allowed | invented_submit | invalid_text`, tính vào `max_steps`. AI được hỏi lại với lý do.
- **Rationale**: chặn độc lập với nội dung AI thấy, nên chữ "dụ AI" trên màn hình hay trong kết quả công cụ không vượt được (FR-014, SC-005).
- **Alternatives**: nhờ AI tự tuân thủ qua prompt — không kiểm chứng được.

## R11. App map và trace (§10, §13, FR-027)

- **Decision**:
  - **App map** ở `appmap/screens.json` (`coral/appmap@1`, contracts/appmap.md):
    - màn hình `{ id, name, fingerprint, package, activity?, snapshot, first_seen_at, seen_in: [exploration_id] }`;
    - chuyển màn `{ from, to, action: <step coral/testcase@1 không có expect> }`;
    - ảnh đại diện ở `appmap/snap/<screen_id>/{screen.jpg,tree.json}`.

    `id` = slug của tên (ASCII, trùng thì thêm `-2`…). Khi kết thúc, gộp theo fingerprint (màn đã có giữ `id`/`name`), ghi **một commit** qua `ProjectRepoStore` (khóa ghi theo project của Phase 1 xếp hàng các commit đồng thời).
  - **Trace**:
    - Bảng `exploration_steps`: thứ tự, fingerprint, `screen_id`, quyết định của AI, trạng thái, `step` (step đã ghi, có chuỗi locator), `brain_call_id`, chi phí.
    - Ảnh và cây ở S3 `<tenant>/explorations/<id>/<n>/{screen.jpg,ai.jpg,tree.json,element.png}`, gắn tag giữ 30 ngày như artifact run (§18).
- **Rationale**: app map là tri thức lâu dài (git, P4); trace là dữ liệu làm việc (30 ngày).
- **Alternatives**: trace trong git — phình repo (R9 SPEC), không cần lâu dài.

## R12. Test writer (§11.2, FR-028–FR-032, clarify 1 và 4)

- **Decision**:
  1. **Đầu vào**: trace chia thành **đoạn** — mỗi đoạn bắt đầu từ một lần mở app sạch (`prepare`) hoặc mở lại. Mỗi bước có:
     - thao tác và tên màn hình trước/sau;
     - chữ mới xuất hiện;
     - đề xuất kỳ vọng của Recorder (`suggestExpects`, không AI);
     - cờ (`never_tap`, `mcp_value`, `invented_text`).
  2. **AI (`writeTest`)** chọn tối đa N flow (N = `max_tests`, mặc định 5). Mỗi flow gồm `{ slug, name, intent, segment, end_step, expects: { <bước>: [kỳ vọng] } }` và chỉ tham chiếu **số bước** (§11.2).
  3. **Hệ thống lắp YAML** (tất định, `apps/server/src/writer/assemble.ts`):
     - bắt đầu bằng `launch` + `preconditions.app_state: fresh` (clarify 4: tự chứa);
     - chép các step đã ghi của đoạn từ đầu đoạn tới `end_step` (bỏ bước bị từ chối, popup);
     - gộp `tap #n` + `type` liền sau vào cùng ô thành một step `type` có `target`;
     - bỏ vòng lặp đi-về (A→B→Back→A) bằng rút gọn theo fingerprint;
     - kỳ vọng của AI **chỉ giữ** khi `checkExpect` của runner thỏa trên cây sau bước đó (FR-029); step chạm không còn kỳ vọng thì lấy đề xuất Recorder đầu tiên nếu có, không thì để cảnh báo `no_expect_after_tap`;
     - chữ secret thành `${secret:NAME}`.
  4. **Kiểm và lưu**:
     - `validateTestCaseSource` (như `coral validate`);
     - trùng: chuỗi hành động chuẩn hóa (action + locator đầu) trùng một test case của project → bỏ, báo "đã có";
     - slug trùng → thêm hậu tố;
     - mỗi test case là **một commit** gồm YAML + `snap/<slug>/<step_id>/` chép từ trace (như Recorder), `source` = `ai_explore` (khám phá tự do) / `ai_prompt` / `ai_import`, `source_ref` = `exploration:<id>` / `import_item:<id>`;
     - trạng thái `draft` cho tới khi xác thực.
  5. **Cờ**: bước có cờ `never_tap` → cờ `needs_review_never_tap` (§9.4); bước dùng giá trị lấy từ công cụ MCP → lý do `needs_human` (clarify của US7).
  - **Chi phí**: `writeTest` tính vào ngân sách của exploration. Hết ngân sách thì dừng viết, flow đã viết vẫn lưu.
- **Rationale**: AI chỉ làm phần hiểu nghĩa (chia flow, đặt tên, `intent`, kỳ vọng); phần có thể sai về kỹ thuật (locator, thứ tự bước, secret) do mã tất định làm (P2).
- **Alternatives**: để AI trả YAML đầy đủ — AI bịa locator, trái §11.2.

## R13. Xác thực test case mới (FR-031)

- **Decision**:
  - Sau khi viết xong (lease exploration đã thả), `ValidationService` tạo cho mỗi test case mới **hai run liên tiếp** `trigger = validation` trên cùng thiết bị và build, qua dispatcher của Phase 1. Run 2 chỉ tạo khi run 1 xong.
  - Nghe sự kiện run xong (`RunEvents`):
    - cả hai `passed` → `active`;
    - một lần fail → `draft`, `draft_reason = validation_failed` kèm mã lỗi và step (`test_cases.validation`).
  - Bản đã sửa trong lúc xác thực: kết quả chỉ áp dụng nếu `head_commit` không đổi; đổi → giữ `draft`, lý do `changed_during_validation`.
  - Exploration ở `validating` tới khi mọi run xác thực xong, rồi `done`.
- **Rationale**: dùng lại toàn bộ đường chạy tất định (P1), kết quả xem được như run thường.
- **Alternatives**: chạy xác thực ngay trong lease exploration bằng `record` — không phải đường chạy lại thật, dễ khác runner.

## R14. Import test case thủ công (§11.3, US6, clarify 5)

- **Decision**:
  - **Đọc file** (server, không AI):
    - CSV: `csv-parse` 7 (MIT) — BOM, dấu ngoặc, xuống dòng trong ô, tự dò dấu phân cách `,`/`;`/tab.
    - Excel `.xlsx`: `read-excel-file` 9 (MIT, còn duy trì, ít phụ thuộc) — sheet đầu hoặc sheet chọn.
    - Gherkin: `@cucumber/gherkin` 42 + `@cucumber/messages` 34 (MIT); `Scenario Outline` × `Examples` thành nhiều case.
  - **Ánh xạ cột** tự đoán theo tên cột (`title|tiêu đề|name`, `precondition|tiền điều kiện`, `step|bước`, `expected|kết quả`, `id`); người dùng sửa được. Dòng có tiêu đề trống nối vào case trước (bước nhiều dòng).
  - **Giới hạn**: ≤ 5 MB, ≤ 200 case (FR-034, Assumptions). Lỗi theo dòng. Xem trước trả tối đa 200 case kèm lỗi.
  - **Lưu**: sau khi xác nhận, mỗi case là `imports/<job_id>/<nnn>-<slug>.yaml` (`coral/manualcase@1`, contracts/manualcase.md), một commit (FR-035).
  - **Job** (`ImportService`): mỗi case một dòng `import_items`, xử lý **tuần tự** trên thiết bị đã chọn:
    1. Exploration **có hướng dẫn** — mục tiêu = tiêu đề + tiền điều kiện + các bước + kết quả mong đợi, ngân sách mỗi case = phần còn lại của job chia đều, tối đa 25 bước.
    2. Test writer với `max_tests = 1`.
    3. Xác thực (R13).
  - **Phân loại** khi không `active`:
    - AI trả `outcome` ∈ `written | needs_human | ambiguous | app_mismatch` kèm bước làm bằng chứng;
    - xác thực fail → `needs_human` (chi tiết `validation_failed`);
    - không bao giờ sửa kết quả mong đợi (P3, FR-037).
  - **Resume**: kết quả từng case ghi ngay khi xong. Server khởi động lại → job `running` tự tiếp từ case `pending` đầu tiên; case đang dở chuyển về `pending`; exploration của nó thành `interrupted`.
  - **Hủy hoặc hết ngân sách**: case chưa làm → `not_processed`. Báo cáo cuối lưu `import_jobs.report` (FR-038).
- **Rationale**: đọc file tất định (P1 với phần không cần AI); dùng lại Explorer + Test writer. Lưu từng case nên resume rẻ.
- **Alternatives**:
  - `xlsx` (SheetJS) bản npm 0.18 cũ, bản mới chỉ phát hành ngoài npm;
  - `exceljs` nặng phụ thuộc, cập nhật cuối 2024;
  - đọc file trong trình duyệt — mất kiểm soát giới hạn, phải gửi nội dung lên server lại.

## R15. Tri thức project: `AGENTS.md`, skills, `mcp.yaml` (FR-015, FR-016, FR-041)

- **Decision**:
  - **Tệp**: `AGENTS.md`, `skills/<name>/SKILL.md` (frontmatter `name`, `description` theo chuẩn Agent Skills; `name` = tên thư mục), `skills/<name>/rules.yaml` (`coral/skill-rules@1`: `never_tap`, `forbidden`, `test_data`, `allow_submit`), `mcp.yaml` (`coral/mcp@1`).
  - **Route** (contracts/rest-api-phase3.md):
    - `GET/PUT /projects/:id/agents-md`;
    - `GET /projects/:id/skills`, `GET/PUT/DELETE /projects/:id/skills/:name` (gồm `SKILL.md` và `rules.yaml`);
    - `GET/PUT /projects/:id/mcp`.
  - **Lưu**: mỗi lần lưu là một commit, có `base_commit` để phát hiện sửa đồng thời như editor Phase 2.
  - **Quyền**: `mcp.yaml` chỉ `owner`/`admin` (FR-016); còn lại `owner`/`admin`/`member`. Thay đổi `mcp.yaml` ghi `audit_log`.
  - **Web**: sửa bằng `YamlEditor` (Phase 2) và editor Markdown (CodeMirror `@codemirror/lang-markdown`), lỗi hiện khi gõ nhờ schema của shared.
- **Rationale**: file thuần trong git (P4, §13); luật máy đọc được tách khỏi `SKILL.md` để giữ đúng chuẩn Agent Skills (khóa lạ trong frontmatter có thể làm công cụ khác từ chối).
- **Alternatives**: nhét `coral:` vào frontmatter `SKILL.md` — lệch chuẩn; luật trong DB — trái P4.

## R16. Nội dung lời gọi AI (clarify 2, FR-006a)

- **Decision**:
  - Mỗi lời gọi (kể cả hỏi lại và lượt công cụ) ghi một JSON vào `<tenant>/ai/<activity_type>/<activity_id>/<brain_call_id>.json`, gắn tag giữ 30 ngày. Nội dung: chữ đã gửi (đã che secret), tham chiếu `ai.jpg` của bước, câu trả lời thô, lý do, các lượt công cụ.
  - `brain_calls.content_key` trỏ tới file. Sau khi object hết hạn, API trả `content: null`; số liệu vẫn còn.
  - Web mở từ từng bước trace; ai xem được hoạt động thì xem được nội dung (FR-042).
- **Rationale**: đúng lựa chọn B; dùng lại lifecycle 30 ngày của bucket (§18).
- **Alternatives**: lưu trong Postgres (jsonb lớn, không tự hết hạn).

## R17. Web (FR-039–FR-041, clarify Q2)

- **Decision**: thêm route TanStack Router (contracts/web-ui-phase3.md):
  - **Explorations**: `/explorations` và `/explorations/$id`.
    - Tab Progress: live view Phase 2 + số liệu + nút Stop.
    - Tab App map: lưới thẻ màn hình (ảnh, tên, số lần thấy) + danh sách chuyển màn.
    - Tab Trace: từng bước, mở "AI saw / AI answered".
    - Tab Findings, tab Test cases.
  - `/projects/$id/explore` (form bắt đầu, có ô **Goal** — tạo từ prompt dùng cùng form).
  - **Import**: `/projects/$id/imports/new` (tải file → chọn cột → xem trước → bắt đầu), `/imports/$id` (tiến độ, báo cáo).
  - Tab **Knowledge** trong project: `AGENTS.md`, skills, `mcp.yaml`.
  - `/settings/brains` (editor `brains.yaml` + bảng chi phí).
  - **Sự kiện trực tiếp** qua `/ws/ui`: `exploration.watch` → `exploration.updated`, `exploration.step`; `import.watch` → `import.updated` (contracts/ui-ws-phase3.md).
- **Rationale**: dùng lại LiveView, YamlEditor, client WS của Phase 2; chuỗi giao diện tiếng Anh (FR-024 Phase 2).

## R18. Kiểm thử và DoD

- **Decision**:
  - **Unit** (CI): fingerprint trên `fixtures/android/*` (cùng màn khác chữ → cùng; khác màn → khác); tuần tự hóa; kiểm an toàn (có màn "dụ AI"); router (dự phòng, giới hạn, đơn giá thiếu); hỏi lại khi JSON sai; vòng công cụ 5 lượt; allowlist MCP với server giả trong tiến trình; đọc CSV/Excel/Gherkin trên `fixtures/manual/`; lắp YAML của Test writer; schema `brains.yaml`/`mcp.yaml`/`rules.yaml`/manualcase/appmap.
  - **Tích hợp** (`*.int.test.ts`, docker compose): exploration với agent giả + brain `fake` → app map commit, trace, lease; xác thực 2 run → `active`/`draft`; job import resume sau restart giả lập; route tri thức + quyền; cô lập tenant (SC-008).
  - **E2E** (Playwright, `CORAL_BRAIN_FAKE=1`, thiết bị giả vẽ app mẫu): khám phá → app map → test case `active`; Brain config; import CSV; MCP OTP giả; chụp ảnh giao diện.
  - **🔌 Device** (workflow `Device`): exploration với brain `fake` trên My Demo App thật (kiểm `observe`/`record`/fingerprint trên cây thật, không tốn tiền).
  - **DoD với AI thật** (clarify Q1): Huynh chạy `scripts/phase3-dod.mjs` trên máy với key Claude + Gemini và emulator cục bộ (quickstart §6). Script làm lần lượt SC-001…SC-004, in bảng kết quả và đường dẫn ảnh để gửi lại.
- **Rationale**: CI tất định, không tốn tiền; phần phụ thuộc chất lượng AI chỉ kiểm được với provider thật, do Huynh chạy.

## R19. Cập nhật SPEC cần Huynh duyệt (ghi Decision log khi đồng ý)

1. §6:
   - `test_cases.source` thêm `ai_explore`; thêm `validation` (jsonb), `draft_reason`, `flags`;
   - bảng mới `exploration_steps`, `findings`, `import_items`;
   - `brain_calls` thêm `ref_type` ∈ exploration/import_job, `attempt`, `content_key`, `error`; `tool_calls` thêm `blocked`.
2. §15: lệnh agent `observe`; `job.assign.items[].screens` cho `expect.screen`.
3. §16: các route mới (contracts/rest-api-phase3.md).
4. §13: `skills/<name>/rules.yaml` (`coral/skill-rules@1`); `imports/<job_id>/*.yaml`.
5. §14.3: `prices:` và `api_key_secret` trong `brains.yaml`; provider `fake` chỉ khi `CORAL_BRAIN_FAKE=1`.
6. D08: `@modelcontextprotocol/*` chỉ trong `@coral/brain`; `apps/server` dùng hàm thuần của `@coral/runner`.
