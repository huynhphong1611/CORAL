# Contract: màn hình web (Phase 3)

Tiếp nối `specs/003-phase-2-web-recorder/contracts/web-ui.md`: giao diện tiếng Anh, route TanStack Router trong `apps/web/src/routes/`, nút ✍ ẩn với `viewer` **và** server từ chối (FR-043); 🔑 chỉ `owner`/`admin`.

| Route | Màn hình | Nội dung chính | Story / FR |
|---|---|---|---|
| `/settings/brains` | Brain config | editor YAML `brains.yaml` (lint khi gõ bằng schema shared: dòng, cột, mã lỗi), **Save** 🔑; bảng provider (enabled, vision); nguồn cấu hình (tenant / platform / none); **Usage**: chi phí theo ngày / vai trò / provider, hôm nay so với giới hạn | US1, FR-040, FR-010 |
| `/projects/$projectId` (tab mới) | **Explorations** | danh sách exploration (kind, goal, trạng thái, lý do dừng, màn hình, test sinh ra, chi phí); nút **Explore** ✍ | US2, FR-039 |
| `/projects/$projectId` (tab mới) | **Knowledge** | `AGENTS.md` (editor Markdown), danh sách skill (tạo / sửa `SKILL.md` + `rules.yaml` / xóa ✍), `mcp.yaml` (sửa 🔑); lint khi gõ; lưu = commit, báo xung đột như editor Phase 2 | US4, US7, FR-041 |
| `/projects/$projectId` (tab mới) | **Imports** | danh sách job import; nút **Import test cases** ✍ | US6 |
| `/projects/$projectId/explore` | Start exploration | chọn app, build, thiết bị rảnh; ô **Goal** (để trống = khám phá tự do; có chữ = tạo test case từ prompt, US5); ngân sách (steps, depth, minutes, cost USD) có sẵn mặc định; **Max test cases** (mặc định 5); **Start** ✍ | US2, US5, FR-020, FR-033 |
| `/explorations/$explorationId` | Exploration | tab **Progress**: live view (Phase 2, chỉ xem), số liệu trực tiếp (bước, màn hình, chi phí / ngân sách, thời gian), thao tác hiện tại, **Stop** ✍. Tab **App map**: lưới thẻ màn hình (ảnh, tên, mới / đã có), danh sách chuyển màn (từ → tới, locator đầu). Tab **Trace**: bảng bước (ảnh nhỏ, màn hình, quyết định, trạng thái / lý do từ chối, chi phí); mở một bước → "What the AI saw" (ảnh + danh sách element) và "What the AI answered" (câu trả lời, lý do, lượt công cụ) — FR-006a. Tab **Findings**: crash / ANR + ảnh + log. Tab **Test cases**: slug, trạng thái (`draft` / `active`), lý do, cờ, link editor. | US2, US3, US5, FR-032, FR-039 |
| `/projects/$projectId/imports/new` | Import test cases | 1) chọn file (CSV / XLSX / .feature, ≤ 5 MB); 2) bảng chọn cột (tự đoán sẵn) + dòng tiêu đề; 3) xem trước các case + lỗi theo dòng; 4) chọn app / build / thiết bị / ngân sách → **Start import** ✍ | US6, FR-034 |
| `/imports/$importId` | Import job | tiến độ trực tiếp (đã làm / tổng, chi phí), **Cancel** ✍; bảng case: tiêu đề, trạng thái, lý do (`needs_human` / `ambiguous` / `app_mismatch` / …), bằng chứng (ảnh, bước), link test case; báo cáo cuối | US6, FR-038 |
| `/projects/$projectId/testcases/$testCaseId` | Test case editor (Phase 2) | thêm: nhãn nguồn (`ai_explore` / `ai_prompt` / `ai_import`, link về exploration hoặc import), trạng thái + `draft_reason`, cờ `needs_review_never_tap`; nút **Activate** / **Quarantine** (✍; bỏ cờ never_tap cần 🔑) | US3, FR-032 |
| `/devices`, `/devices/$deviceId` (Phase 2) | Devices | trạng thái thêm `exploring by …` (link tới exploration) | FR-020 |

## Hành vi chung

- Tiến độ exploration và import qua `/ws/ui` (contracts/ui-ws-phase3.md); tải lại trang thì khôi phục từ REST.
- Chi phí luôn hiện cùng giới hạn (ví dụ `$0.82 / $3.00`).
- Hết ngân sách hoặc chạm giới hạn ngày: exploration hiện lý do dừng, không coi là lỗi.
- Tenant chưa cấu hình bộ não: màn Explore và Import hiện "AI is not configured" + link `/settings/brains`.
- Nội dung AI quá 30 ngày: "Content expired (kept 30 days)".
