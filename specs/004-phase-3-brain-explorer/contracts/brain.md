# Contract: Bộ não AI (`packages/brain`)

Giao diện dùng trong server (§14.1, D05). Schema Zod của câu trả lời nằm ở `packages/shared/src/ai/decisions.ts`; JSON Schema gửi provider sinh từ chính schema đó (research R3). Mọi câu trả lời được kiểm bằng Zod; sai → hỏi lại tối đa 2 lần kèm lỗi → `BrainOutputError`.

## 1. Giao diện

```ts
interface Brain {
  describeScreen(i: ScreenInput, ctx: CallContext): Promise<ScreenSummary>
  nextAction(i: DecideInput, ctx: CallContext): Promise<ActionDecision>
  writeTest(i: WriteTestInput, ctx: CallContext): Promise<TestPlan>
  // Phase 4: diagnose(), resolvePopup() — có trong interface, chưa có vai trò gọi
}

interface CallContext {
  tenantId: string
  role: 'explorer' | 'writer'
  ref: { type: 'exploration' | 'import_job'; id: string }  // cộng chi phí, ghi brain_calls
  budget: { maxCostUsd: number; spentUsd: () => Promise<number> }
  knowledge: ProjectKnowledge                 // AGENTS.md, skills, rules — CHỈ project đang chạy
  tools: ToolSet                              // MCP đã lọc allowlist + read_skill
  redactor: Redactor                          // giá trị secret → ${secret:NAME}
}
```
Router (`createBrain(config, deps)`) trả một `Brain` định tuyến theo `ctx.role` (contracts/brains-yaml.md). `describeScreen` dùng provider của vai trò `explorer`.

## 2. Màn hình gửi cho AI (`ScreenInput`)

```
Screen 1080x2400 · app com.saucelabs.mydemoapp.android · known as "Catalog" (or: new screen)
#1 ImageView id="menuIV" desc="View menu" [32,154,79,79] tried
#2 TextView text="Sauce Labs Backpack" [44,640,420,60] new
#3 EditText id="nameET" [60,700,960,120] field
#4 EditText id="passwordET" [60,860,960,120] field password
…
```
- Kèm một ảnh (`ai.jpg`, cạnh dài ≤ 1024).
- Tối đa 80 element, thứ tự đọc.
- Chỉ có element thao tác được. Element `never_tap` hoặc bị skill cấm không có trong danh sách (research R6).
- Chữ trùng giá trị secret đã được thay bằng `${secret:NAME}`.

## 3. Câu trả lời

**`ScreenSummary`**
```json
{ "name": "Catalog", "purpose": "List of products with a menu button" }
```
- `name` ≤ 60 ký tự, theo ngôn ngữ của `AGENTS.md` (mặc định tiếng Việt).

**`ActionDecision`** (discriminated union theo `action`)
```json
{ "action": "tap", "element": 12, "reason": "…" }
{ "action": "long_press", "element": 12, "reason": "…" }
{ "action": "type", "element": 3, "text": "backpack", "reason": "…" }
{ "action": "type", "element": 3, "secret": "TEST_USER", "reason": "…" }
{ "action": "type", "element": 3, "test_data": "shipping_zip", "reason": "…" }
{ "action": "swipe", "element": 7, "direction": "up", "reason": "…" }
{ "action": "back", "reason": "…" }
{ "action": "hide_keyboard", "reason": "…" }
{ "action": "restart_app", "reason": "…" }
{ "action": "tap_point", "point_pct": [0.5, 0.42], "reason": "…" }   // chỉ khi danh sách rỗng
{ "action": "done", "goal_reached": true, "reason": "…" }            // chế độ có mục tiêu
```
- `element` là số trong danh sách của màn hình hiện tại. `reason` ≤ 300 ký tự.
- `type` có đúng một trong `text` (≤ 64 ký tự), `secret`, `test_data`.
- `done` chỉ hợp lệ khi có `goal`. Với `goal_reached: false` AI giải thích vì sao không đạt được (ví dụ cần thao tác bị cấm).

**`TestPlan`** (`writeTest`)
```json
{
  "flows": [
    {
      "slug": "open-backpack-details",
      "name": "Mở chi tiết sản phẩm",
      "intent": "Từ danh sách sản phẩm, mở Sauce Labs Backpack và thấy giá",
      "segment": 2,
      "end_step": 17,
      "expects": [ { "step": 17, "visible_text": "$29.99" }, { "step": 15, "candidate": 0 } ]
    }
  ],
  "outcome": "written"
}
```
- `flows` ≤ `max_tests`.
- `slug` khớp slug của `coral/testcase@1`.
- `segment` và `end_step` là số của trace.
- `expects`: mỗi mục là `visible_text` (chữ phải có trên màn hình sau bước đó) **hoặc** `candidate` (số thứ tự trong danh sách kỳ vọng ứng viên mà hệ thống đưa cho bước đó — đề xuất của Recorder, locator đọc từ cây). AI không bao giờ viết locator (P2). Hệ thống kiểm lại trên snapshot (FR-029).
- `outcome` chỉ dùng khi import (một case): `written | needs_human | ambiguous | app_mismatch`, kèm `evidence_step` và `explanation` khi khác `written`.

## 4. Công cụ

- **MCP**: tên `<server>__<tool>`, schema đầu vào của MCP server. Chỉ công cụ trong allowlist được khai báo cho AI (contracts/project-knowledge.md).
- **Nội bộ**: `read_skill { name }` → nội dung `SKILL.md` của project đang chạy.
- **Giới hạn**: tối đa 5 lượt công cụ mỗi quyết định; sau đó AI phải trả câu trả lời cuối.
- **Khi bị chặn**: AI nhận `{ "error": "not_allowed" }` hoặc `{ "error": "side_effects_disabled" }`.
- **Kết quả**: cắt ở 8 KB, secret bị che.

## 5. Adapter (mỗi provider cài một hàm)

```ts
interface ProviderAdapter {
  id: 'claude' | 'gemini' | 'copilot' | 'fake'
  vision: boolean
  chat(req: ChatRequest): Promise<ChatResponse>
}
interface ChatRequest {
  model: string
  system: { stable: string; volatile: string }  // stable được cache khi provider hỗ trợ
  messages: ChatMessage[]                        // user/assistant/tool_result, ảnh base64
  tools: ToolSpec[]                              // rỗng ở lượt cuối
  outputSchema: JsonSchema                       // câu trả lời cuối
  options?: { effort?: string; timeoutMs: number }
}
interface ChatResponse {
  kind: 'final' | 'tool_calls'
  text?: string
  toolCalls?: { id: string; name: string; args: unknown }[]
  usage: { input: number; output: number; cachedInput: number }
  stop: 'end' | 'max_tokens' | 'refusal' | 'tool_use'
}
```
**Lỗi** chuẩn hóa về `ProviderError { kind: timeout | rate_limited | auth | refusal | provider_error | bad_request }`. Router dùng `kind` để quyết định dự phòng: mọi `kind` trừ `bad_request` → provider kế tiếp.

## 6. Nội dung lời gọi lưu 30 ngày (`BrainCallContent`, FR-006a)

```json
{
  "role": "explorer", "provider": "gemini", "model": "…", "attempt": 1,
  "system": { "stable_hash": "…", "volatile": "…" },
  "messages": [ { "role": "user", "text": "…", "image": "explorations/<id>/<n>/ai.jpg" } ],
  "rounds": [ { "tool_calls": [ { "name": "otp__get_otp", "args": { "phone": "${secret:TEST_PHONE}" }, "result": "…" } ] } ],
  "answer": "{…raw…}", "validation_errors": [], "decision": { … }
}
```
- Phần `system.stable` (vai trò + `AGENTS.md` + danh sách skill) chỉ lưu hash. Nội dung gốc xem được trong git của project.
