# Implementation Plan: Phase 3 — Brain layer, Explorer, Test writer

**Branch**: `claude/phase-0-planning-tech-stack-6m4j5c` (feature `004-phase-3-brain-explorer`) | **Date**: 2026-09-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-phase-3-brain-explorer/spec.md`

## Summary

AI khám phá app và sinh test case; test case sinh ra vẫn chạy lại tất định như Phase 1–2.

1. **Brain layer** (`packages/brain`):
   - giao diện `Brain` (§14.1);
   - adapter `claude`, `gemini` và `copilot` (sau cờ); adapter `fake` có kịch bản cho CI;
   - router theo `brains.yaml`: dự phòng, giới hạn chi phí, ghi `brain_calls`;
   - vòng công cụ tối đa 5 lượt với **MCP client** (allowlist, chặn công cụ có tác dụng phụ, ghi `tool_calls`).
2. **Explorer** (server): điều khiển thiết bị từng bước qua agent.
   - Mỗi bước: `observe` mới → fingerprint (D24) → app map → danh sách element đánh số → AI chọn → kiểm an toàn tất định (`never_tap`, skill cấm, chặn gửi form bằng dữ liệu tự đặt) → `record` của Recorder Phase 2 (chuỗi locator lấy từ cây, không AI).
   - Dừng khi hết ngân sách, đạt mục tiêu, hoặc người dùng dừng. App map commit vào repo; trace giữ 30 ngày.
3. **Test writer**: tự chạy khi khám phá xong, tối đa 5 flow.
   - AI chỉ chọn flow, đặt tên, viết `intent`, đề xuất kỳ vọng.
   - Hệ thống lắp YAML tự chứa từ step đã ghi và kiểm kỳ vọng trên snapshot.
   - Xác thực bằng 2 run `validation` → `active` hoặc `draft` kèm lý do.
4. **Prompt và import**:
   - Prompt = exploration có mục tiêu.
   - Import CSV/XLSX/Gherkin → `coral/manualcase@1` → khám phá có hướng dẫn từng case; job nền tự chạy tiếp sau khi server khởi động lại.
5. **Web**: Brain config + chi phí, Explorations (tiến độ, app map, trace với "AI thấy gì / trả lời gì"), Knowledge (`AGENTS.md`, skills, `mcp.yaml`), Import.

Hướng kỹ thuật:
- AI chỉ ở `packages/brain` và dịch vụ server. Agent chỉ thêm `observe`.
- Server dùng hàm thuần của `@coral/runner` (hit-test, `checkExpect` trên cây tĩnh) để bản nháp khớp lúc chạy lại.
- CI không cần key AI. DoD với Claude + Gemini thật do Huynh chạy trên máy bằng `scripts/phase3-dod.mjs` (clarify Q1).

Chi tiết: [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict), Node.js 24 LTS, ESM; trình duyệt như Phase 2

**Primary Dependencies** (mới, tra npm 2026-09-30):
- `packages/brain`: `@anthropic-ai/sdk` 0.129 (MIT), `@google/genai` 2.24 (Apache-2.0), `@github/copilot-sdk` 1.0 (MIT, tùy chọn — cần Copilot CLI trên máy server), `@modelcontextprotocol/sdk` 1.31 (MIT)
- `apps/server`: `csv-parse` 7 (MIT), `read-excel-file` 9 (MIT), `@cucumber/gherkin` 42 + `@cucumber/messages` 34 (MIT); `@coral/runner` (workspace, chỉ hàm thuần)
- `apps/web`: `@codemirror/lang-markdown` (MIT)
- `fixtures/mcp`: MCP server giả dùng `@modelcontextprotocol/sdk` (dev dependency của gói test)

**Storage**:
- Postgres: bảng mới `explorations`, `exploration_steps`, `findings`, `brain_calls`, `tool_calls`, `import_jobs`, `import_items`; đổi `test_cases`, `runs`, `tenants.settings`.
- S3: `explorations/`, `ai/`, `imports/` (tag giữ 30 ngày).
- Repo project: `AGENTS.md`, `skills/`, `mcp.yaml`, `appmap/`, `imports/`.

**Testing**:
- Vitest (unit; `*.int.test.ts` với docker compose) với adapter `fake` và MCP server giả trong tiến trình.
- Playwright E2E với thiết bị giả + brain `fake`.
- 🔌 workflow Device: exploration brain `fake` trên My Demo App thật.
- DoD AI thật: `scripts/phase3-dod.mjs` trên máy Huynh.

**Target Platform**: như Phase 2 (server Linux, agent cạnh thiết bị Android, web desktop)

**Project Type**: monorepo — web SPA + web service + daemon + CLI + thư viện runner + thư viện brain

**Performance Goals**:
- Mỗi bước khám phá p50 ≤ 10 s (phần lớn là thời gian AI); tiến độ web ≤ 3 s sau mỗi bước; Stop ≤ 15 s (SC-011).
- Xem trước import 100 case ≤ 10 s (SC-012).
- Ảnh gửi AI ≤ 1024 px (≈ 1–1,6 nghìn token).

**Constraints**:
- P1: không AI/MCP trong runner/agent/cli; boundaries kiểm `@modelcontextprotocol/*`.
- P2: locator luôn từ cây qua Recorder.
- P3: không sửa test case có sẵn, không sửa kết quả mong đợi của import.
- P4: tri thức là file trong git.
- P5: ngữ cảnh AI chỉ từ project đang chạy; mọi bảng có `tenant_id`.
- P6: `never_tap` + skill cấm + chặn gửi form tự đặt, kiểm sau AI; công cụ có tác dụng phụ tắt mặc định.
- Không hard-code tên model.
- Secret không bao giờ gửi cho AI dạng chữ.

**Scale/Scope**:
- ≤ 5 exploration đồng thời mỗi tenant (`CORAL_MAX_EXPLORATIONS`).
- Một exploration ≤ 60 bước / 20 phút mặc định; app map ≤ 500 màn hình; import ≤ 200 case / 5 MB.
- 7 user story, khoảng 6 màn web mới.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Thiết kế Phase 3 | Trước research | Sau design |
|---|---|---|---|
| I. AI viết, script chạy (P1) | LLM SDK và MCP SDK chỉ trong `packages/brain`; chỉ `apps/server` import brain. `boundaries.mjs` thêm `@modelcontextprotocol/*` (kiểm cả lockfile bắc cầu). Agent chỉ thêm `observe` (tất định). Runner chạy lại test không gọi AI/MCP; test case không tham chiếu MCP. Server → runner chỉ là hàm thuần, runner không kéo LLM. | PASS | PASS |
| II. Locate, don't memorise (P2) | AI chỉ trả **số element**. Hệ thống chạm tâm bounds bằng `record` của Recorder: chuỗi locator trích từ cây, locator đầu kiểm lại. Test writer lắp YAML từ step đã ghi, không lấy locator từ AI. `point_pct` chỉ khi màn hình không có element dùng được. | PASS | PASS |
| III. No blind healing (P3) | Không sửa test case có sẵn (trùng thì bỏ bản mới). Kết quả mong đợi của import giữ nguyên; lệch → `app_mismatch`. AI không đổi `intent` của ai khác. Test AI sinh thành `active` theo §11.2 (xác thực 2 lần). Bản có `never_tap` cần duyệt riêng (§9.4). | PASS | PASS |
| IV. Provider-neutral knowledge (P4) | `AGENTS.md`, `SKILL.md`, `rules.yaml`, `mcp.yaml`, `appmap/`, `imports/` là file thuần trong git; prompt viết trung lập provider; `brains.yaml` xuất/nhập được, tên model là cấu hình. | PASS | PASS |
| V. Tenant isolation (P5) | Bảng mới có `tenant_id`, qua repository scope. Prompt builder chỉ đọc repo của project đang chạy. MCP theo project. Nội dung AI và trace dưới prefix tenant. Đăng ký WS kiểm tenant. Secret che trước khi gửi AI và trước khi lưu. | PASS | PASS |
| VI. Safe operation (P6) | Kiểm an toàn sau mỗi quyết định, độc lập nội dung AI thấy: `never_tap`, skill cấm, chặn gửi form bằng dữ liệu tự đặt, element phải tồn tại. Lệnh agent vẫn là danh sách đóng (`restart_app` chỉ package đang test). MCP: allowlist + công cụ có tác dụng phụ tắt mặc định + server stdio theo allowlist nền tảng. | PASS | PASS |
| Ràng buộc kỹ thuật | Zod cho mọi output AI, kết quả công cụ, file import, cấu hình, message WS/REST mới; `snake_case` trên dây; migration Drizzle mới; test `*.int.test.ts` / `*.device.test.ts` theo quy ước. | PASS | PASS |

Không có vi phạm nguyên tắc. Lựa chọn làm tăng độ phức tạp ghi ở Complexity Tracking. Các điểm cần cập nhật SPEC (research R19) trình Huynh duyệt cùng plan này.

## Project Structure

### Documentation (this feature)

```text
specs/004-phase-3-brain-explorer/
├── plan.md
├── research.md                   # R1–R19
├── data-model.md
├── quickstart.md                 # kịch bản + DoD trên máy Huynh
├── contracts/
│   ├── rest-api-phase3.md        # route mới + vai trò
│   ├── brain.md                  # giao diện Brain, câu trả lời, adapter, nội dung lời gọi
│   ├── brains-yaml.md            # coral/brains@1
│   ├── project-knowledge.md      # AGENTS.md, SKILL.md, rules.yaml, mcp.yaml
│   ├── manualcase.md             # coral/manualcase@1 + đọc CSV/XLSX/Gherkin
│   ├── appmap.md                 # coral/appmap@1
│   ├── agent-ws-phase3.md        # observe, job.assign.screens
│   ├── ui-ws-phase3.md           # exploration.*, import.*
│   └── web-ui-phase3.md
├── checklists/requirements.md
└── tasks.md                      # /speckit-tasks
```

### Source Code (repository root)

```text
packages/shared/src/
├── ai/decisions.ts               # MỚI: ScreenSummary, ActionDecision, TestPlan (Zod)
├── brains/schema.ts              # MỚI: coral/brains@1 + validateBrainsSource (lint dòng/cột)
├── mcp/schema.ts                 # MỚI: coral/mcp@1
├── knowledge/skill.ts            # MỚI: frontmatter SKILL.md, coral/skill-rules@1
├── manualcase/schema.ts          # MỚI: coral/manualcase@1, ImportMapping
├── appmap/schema.ts, fingerprint.ts   # MỚI: coral/appmap@1, screenFingerprint (D24)
├── protocol/messages.ts          # + observe, job.assign.items[].screens
├── protocol/ui.ts                # + exploration.*, import.*
└── api/                          # + brains, explorations, imports, knowledge

packages/brain/src/
├── brain.ts                      # Brain, CallContext, createBrain (router)
├── router.ts                     # vai trò → provider, dự phòng, giới hạn, ghi lời gọi (qua callback)
├── structured.ts                 # Zod → JSON Schema, kiểm + hỏi lại ≤ 2, vòng công cụ ≤ 5
├── prompts/                      # explorer.ts, writer.ts, describe.ts (tiếng Anh, trung lập provider)
├── adapters/                     # claude.ts, gemini.ts, copilot.ts, fake.ts
└── tools/mcp.ts, skills.ts       # MCP client (allowlist, side effects, timeout), read_skill

packages/runner/src/
├── core/expect.ts                # expect.screen bằng screenFingerprint
├── core/image/downscale.ts       # MỚI: thu nhỏ ảnh cho AI (JS thuần)
└── drivers/android/…             # foregroundActivity() (dumpsys)

apps/agent/src/
└── recorder.ts / commands.ts     # + lệnh observe

apps/server/src/
├── ai/                           # MỚI: brains-config.ts (nguồn cấu hình, đơn giá), usage.ts, screen.ts (tuần tự hóa), knowledge.ts (đọc AGENTS/skills/rules của project), content.ts (lưu nội dung 30 ngày)
├── explorer/                     # MỚI: service.ts (vòng lặp, lease, dừng, interrupted), safety.ts, frontier.ts, appmap.ts (gộp + commit)
├── writer/                       # MỚI: assemble.ts (lắp YAML), service.ts (viết + lưu), validation.ts (2 run → active/draft)
├── imports/                      # MỚI: parse-csv.ts, parse-xlsx.ts, parse-gherkin.ts, mapping.ts, service.ts (job, resume)
├── routes/                       # + brains, usage, brain-calls, knowledge, explorations, appmap, imports; testcases PATCH status
├── runs/dispatcher.ts            # + items[].screens từ appmap
├── db/migrations/                # 000N_phase3.sql
└── ai-prices.yaml                # MỚI: bảng đơn giá nền tảng (dữ liệu, không phải code)

apps/web/src/
├── routes/settings/brains.tsx    # Brain config + Usage
├── features/explorations/        # StartExploration, ExplorationPage (Progress, App map, Trace, Findings, Test cases)
├── features/knowledge/           # AGENTS.md, skills, mcp.yaml editors
├── features/imports/             # ImportWizard, ImportJobPage
└── i18n/en.ts

fixtures/
├── manual/                       # mydemo-10.csv, mẫu .xlsx, .feature, file lỗi
├── mcp/otp-server.ts             # MCP server giả (get_otp, send_sms, delete_user)
└── android/…                     # thêm cặp màn "cùng màn khác chữ" cho fingerprint

scripts/boundaries.mjs            # + @modelcontextprotocol/*
scripts/phase3-dod.mjs            # MỚI: DoD với AI thật (máy Huynh)
examples/brains.fake.yaml         # MỚI: cấu hình provider fake cho dev/CI
e2e/us*-phase3.e2e.ts             # MỚI: khám phá, brain config, import, MCP
.github/workflows/device.yml      # + exploration brain fake trên emulator
```

**Structure Decision**: giữ monorepo, không thêm gói mới.
- Phần AI nằm trong `packages/brain` có sẵn từ Phase 0.
- Dịch vụ điều phối (Explorer, Test writer, Import) ở `apps/server` (§5.2).
- Schema định dạng file ở `packages/shared` để web lint khi gõ.
- Agent chỉ thêm một lệnh.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Bốn adapter provider (có `fake`) sau một hàm `chat()` chung | SPEC §14.2 yêu cầu Claude, Gemini, Copilot. CI không có key (clarify Q1) → cần `fake` tất định | Thư viện đa provider (`ai`/`@ai-sdk`): khó kiểm soát cache và tính token; không làm `fake` gọn hơn |
| Server phụ thuộc `@coral/runner` (hàm thuần) | Danh sách element thao tác được và kiểm kỳ vọng trên snapshot phải **giống hệt** lúc chạy lại (P2, FR-029) | Chép logic vào server: hai bản dễ lệch. Chuyển resolver sang shared: tái cấu trúc lớn |
| Lệnh agent mới `observe` (cây inline + 2 ảnh) | AI cần cây + ảnh sau mỗi thao tác; `record` chỉ trả step | Tải `tree.json` từ S3 mỗi bước: thêm một vòng mạng; RPC u2 từng lệnh từ server: lặp logic runner |
| Lưu nội dung lời gọi AI 30 ngày | Clarify 2 (Huynh chọn B): cần để gỡ lỗi quyết định của AI | Chỉ lưu số liệu: không biết AI đã thấy gì khi nó làm sai |
| Job import tự chạy tiếp sau restart (DB-driven) | Clarify 5: job dài tới 60 phút, dev hay khởi động lại server | BullMQ job: phải chia nhỏ theo case và vẫn cần trạng thái DB; resume bằng DB đơn giản hơn ở một instance (R10 SPEC) |
| MCP client trong server (brain) + MCP server giả để test | DoD Phase 3 (SC-003), §14.5 | Không làm MCP ở Phase 3: trái ROADMAP |
