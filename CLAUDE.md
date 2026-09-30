# coral

**CORAL** = Continuous Observation, Repair & Adaptive Learning — *tests that grow back.*

Hệ thống test tự động cho app mobile (Android/iOS): AI nhìn màn hình, khám phá app và viết test case; test case được chạy lại **không cần AI**; khi lỗi, AI phân biệt "UI đổi" (đề xuất tự sửa) với "bug thật" (báo bug); tri thức tích lũy qua mỗi lần chạy. Bộ não AI thay được giữa Claude, Gemini, GitHub Copilot.

## Đọc trước khi làm
1. `docs/SPEC.md` — kiến trúc và hành vi (nguồn sự thật).
2. `docs/ROADMAP.md` — phase hiện tại, task và Definition of Done.
3. `examples/` — mẫu test case, popup rules, brain routing.
4. `.specify/memory/constitution.md` — nguyên tắc bất biến dạng Spec Kit; `specs/<feature>/` — spec, plan, tasks của phase đang làm.

## Nguyên tắc bất biến (SPEC §2)
- **P1 — AI viết, script chạy.** Chỉ `packages/brain` được phụ thuộc LLM SDK; chỉ `apps/server` được phụ thuộc `@coral/brain`; app không import app khác (D08). `pnpm check:boundaries` và ESLint kiểm tra tự động.
- **P2 — Lưu cách tìm element.** Chuỗi locator dự phòng; luôn tap vào tâm `bounds` đọc lúc chạy; `point_pct` là phương án cuối.
- **P3 — Không heal mù.** Mọi thay đổi test case là đề xuất cần người duyệt; không xóa hay nới lỏng `expect`, không đổi `intent`.
- **P4 — Tri thức trung lập provider.** File thuần (YAML/JSON/Markdown), không gắn với một provider.
- **P5 — Cô lập tenant.** Mọi bảng nghiệp vụ có `tenant_id` (trừ `tenants`, `users`, `refresh_tokens` — D10); truy cập DB qua repository có tenant scope; ngữ cảnh AI chỉ lấy từ project đang chạy.
- **P6 — An toàn thao tác.** Tôn trọng `never_tap` cho mọi hành động máy tự quyết (SPEC §9.4); không chạy lệnh phá hủy thiết bị.

## Cấu trúc repo
```
apps/server       control plane: API, auth, orchestrator, queue      (@coral/server)
apps/web          React SPA                                          (@coral/web)
apps/agent        daemon cạnh thiết bị: runner, popup guard, live view (@coral/agent)
packages/shared   types + Zod schema (testcase, popups, WS messages) (@coral/shared)
packages/brain    Brain interface + adapters (claude, gemini, copilot)(@coral/brain)
packages/cli      lệnh `coral`                                       (@coral/cli)
packages/runner   runner tất định dùng chung agent + cli (từ Phase 1, D09)
fixtures/         app fixture và dữ liệu test
examples/         mẫu YAML
docs/             SPEC, ROADMAP
scripts/          công cụ repo (check-boundaries)
specs/            tài liệu Spec Kit theo phase (spec, plan, tasks)
.specify/         Spec Kit: constitution, templates, scripts
```

## Quy ước
- TypeScript strict, ESM, Node 24. Zod cho mọi dữ liệu đi vào từ bên ngoài: YAML, message WebSocket, request API, output của LLM, biến môi trường.
- Gói trong `packages/*` xuất thẳng source TS (không có bước build riêng); `apps/*` và `packages/cli` được bundle bằng `tsdown` / Vite khi build.
- Định dạng dây (YAML, JSON API, WS, cột DB) dùng `snake_case`; biến/hàm TS dùng `camelCase` (D12).
- Code, tên biến, comment, commit message bằng **tiếng Anh**. Trao đổi với Huynh bằng **tiếng Việt**.
- Không hard-code tên model AI; đọc từ cấu hình.
- Secret chỉ ở `.env` (không commit) hoặc bảng `secrets` đã mã hóa. Trong YAML chỉ dùng `${secret:NAME}`.
- Test: Vitest, file `*.test.ts` cạnh code. Test cần thiết bị thật đặt tên `*.device.test.ts` — bị bỏ qua mặc định và trong các job CI thường; chạy bằng `pnpm test:device`, và trên emulator Android 14 trong workflow Device (`.github/workflows/device.yml`, D21, D37). Test cần Postgres/Redis/MinIO đặt tên `*.int.test.ts` — chạy bằng `pnpm test:int` (có job CI riêng, D34).
- Migration DB bằng Drizzle; không sửa migration đã chạy.

## Cách làm việc
1. Chỉ làm task của **phase hiện tại** trong `docs/ROADMAP.md`.
2. Trước khi code một nhóm task: đọc các mục SPEC liên quan, trình bày kế hoạch ngắn, chờ Huynh đồng ý.
3. Commit nhỏ, mỗi task kèm test. Đánh dấu `[x]` trong ROADMAP (và `specs/<feature>/tasks.md`) khi xong.
4. Khi cần lệch khỏi SPEC: hỏi trước; nếu được đồng ý thì cập nhật SPEC và ghi vào §21 Decision log.
5. Hết phase: tự kiểm tra từng mục DoD, báo cáo kết quả, cập nhật dòng "Phase hiện tại" trong ROADMAP.

### Quy trình Spec Kit (D22)
Mỗi phase trong ROADMAP là một feature: `specs/NNN-phase-N-<slug>/` (Phase 0 = `001-phase-0-foundation`).
1. `/speckit-specify` — viết `spec.md` (cái gì, vì sao) từ mục phase trong ROADMAP + các § liên quan của SPEC.
2. `/speckit-clarify` — hỏi lại chỗ mơ hồ, ghi câu trả lời vào spec (và SPEC/Decision log nếu là quyết định hệ thống).
3. `/speckit-plan` — `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`; kiểm tra với constitution.
4. `/speckit-tasks` — `tasks.md`; `/speckit-analyze` — kiểm tra nhất quán spec ↔ plan ↔ tasks.
5. `/speckit-implement` — làm theo `tasks.md`, dừng chờ Huynh duyệt theo mục "Cách làm việc" ở trên.

Spec Kit v1.0.12 không tạo nhánh git (chưa cài extension git); nhánh do môi trường quyết định (ví dụ `claude/...`). Thư mục feature đang làm được lưu ở `.specify/feature.json` (máy cục bộ, không commit) khi chạy `/speckit-specify`; với feature đã có, đặt `export SPECIFY_FEATURE_DIRECTORY=specs/NNN-phase-N-<slug>` trước khi chạy các skill `/speckit-*`.

## Lệnh thường dùng
```bash
pnpm install                 # cài dependency (Node 24, pnpm ghim qua packageManager / corepack)
pnpm dev                     # chạy server (:3000), web (:5173, proxy /api → server), agent
pnpm build                   # bundle server/agent/cli (tsdown) và web (vite)
pnpm lint                    # ESLint toàn repo (type-aware)
pnpm format                  # Prettier ghi đè;  pnpm format:check để chỉ kiểm tra
pnpm typecheck               # tsc --noEmit từng gói + scripts
pnpm test                    # Vitest toàn repo (bỏ qua *.device.test.ts và *.int.test.ts)
pnpm test:int                # thêm test tích hợp *.int.test.ts (cần docker compose đang chạy + db:migrate)
pnpm test:device             # chỉ chạy test cần thiết bị thật
pnpm test:e2e                # Playwright trên Chromium: server + web (vite preview) + agent thiết bị giả (cần docker compose + db:migrate)
pnpm dev:fake-device         # agent + thiết bị giả vẽ My Demo App (CORAL_AGENT_TOKEN trong .env) — demo, live view, Recorder
pnpm check:boundaries        # kiểm tra luật phụ thuộc P1 (manifest + lockfile)
pnpm coral --help            # chạy CLI từ source
pnpm coral validate <file...> [--project-root <dir>]   # kiểm tra test case / popups.yaml (exit 0 hợp lệ, 1 có lỗi); có --project-root thì kiểm cả file ảnh
pnpm coral devices                       # thiết bị Android đang kết nối (adb)
pnpm coral run <tc.yaml> --app <package> [--device <udid>] [--apk <file>] [--project-root <dir>]   # chạy cục bộ, không cần server; ảnh của locator `image` tính từ project root
pnpm --filter @coral/server db:migrate   # áp migration Drizzle
pnpm --filter @coral/server db:seed      # tạo owner từ CORAL_SEED_EMAIL / CORAL_SEED_PASSWORD
pnpm --filter @coral/server test          # test một gói
node scripts/phase1-e2e.mjs --help       # kiểm DoD Phase 1 qua REST API (5 run, artifact, --scan-secrets)
docker compose up -d --wait  # postgres :5432, redis :6379, minio :9000 (console :9001)
docker compose down          # dừng; thêm -v để xóa dữ liệu
```
Cấu hình: chép `.env.example` thành `.env` ở gốc repo; server và agent tự đọc file này khi `pnpm dev`. Agent cần `CORAL_AGENT_TOKEN` (tạo bằng `POST /agents`); secret cho test case đặt dạng `CORAL_SECRET_<NAME>` (chỉ dev, D19).
