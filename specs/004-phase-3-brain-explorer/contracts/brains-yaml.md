# Contract: `brains.yaml` — `coral/brains@1` (§14.3, D20)

Cấu hình bộ não theo tenant, lưu trong `tenants.settings.brains` (JSON đã kiểm), nhập/xuất dạng YAML qua `GET/PUT /brains/config`. Schema Zod ở `packages/shared/src/brains/schema.ts` — web dùng cùng schema để báo lỗi khi gõ. Tên model là cấu hình, không bao giờ nằm trong code (P4).

```yaml
schema: coral/brains@1

roles:                                   # Phase 3 dùng explorer và writer; healer, popup cho Phase 4
  explorer: { provider: gemini, model: '<flash-class>' }
  writer:   { provider: claude, model: '<reasoning-class>', effort: medium }

fallback: [claude, gemini]               # thử theo thứ tự khi provider của vai trò lỗi (bỏ qua trùng)

providers:                               # tùy chọn: model mặc định khi dự phòng, key riêng (BYOK)
  claude: { model: '<reasoning-class>', api_key_secret: ANTHROPIC_KEY }
  gemini: { model: '<flash-class>' }
  copilot: { enabled: false }            # cần thêm CORAL_COPILOT_ENABLED=1 trên server (FR-009)

limits:
  max_cost_usd_per_day: 20               # theo ngày UTC, cho cả tenant
  max_cost_usd_per_exploration: 3        # mặc định ngân sách chi phí của một exploration
  max_cost_usd_per_import: 10            # mặc định ngân sách của một job import

prices:                                  # tùy chọn: ghi đè bảng đơn giá của nền tảng (USD / 1 triệu token)
  '<flash-class>': { input: 0.30, output: 2.50, cached_input: 0.075 }
```

## Luật kiểm (lỗi kèm dòng/cột)

- **Vai trò**:
  - `roles.explorer` bắt buộc; `roles.writer` thiếu thì dùng `roles.explorer`.
  - Vai trò lạ → `schema`.
- **Provider**:
  - `provider` ∈ `claude | gemini | copilot`. `fake` chỉ nhận khi server chạy với `CORAL_BRAIN_FAKE=1` (test/E2E).
  - Provider lạ → `unknown_provider`.
  - `copilot` khi chưa bật (cờ tenant **và** biến môi trường) → `provider_disabled`.
  - Vai trò `explorer` cần ảnh: gán provider `vision: false` (Copilot) → `vision_required`.
- **Model và đơn giá**:
  - `model` bắt buộc ở vai trò, hoặc lấy từ `providers.<id>.model`.
  - Mọi model dùng tới (vai trò + dự phòng) phải có đơn giá trong `prices` hoặc trong bảng của nền tảng (`apps/server/ai-prices.yaml`, đường dẫn đổi bằng `CORAL_AI_PRICES`) → nếu thiếu: `price_missing`.
- **Giới hạn**: > 0 và ≤ 10 000 → nếu sai: `invalid_limit`.
- **Key**:
  - `api_key_secret` là **tên** secret (`[A-Za-z_][A-Za-z0-9_]*`), giá trị lấy từ `CORAL_SECRET_<NAME>` (dev, D19).
  - Không có → dùng key nền tảng: `CORAL_ANTHROPIC_API_KEY`, `CORAL_GEMINI_API_KEY`.
  - Không có key nào cho provider → lời gọi tới provider đó lỗi `auth`, router chuyển sang dự phòng.

## Nguồn cấu hình

- `tenants.settings.brains` (tenant).
- Nếu không có: file `CORAL_BRAINS_DEFAULT` (nền tảng).
- Không có cả hai: `GET /brains/config` trả `source: "none"`; exploration/import trả 409 `brains_not_configured`.
