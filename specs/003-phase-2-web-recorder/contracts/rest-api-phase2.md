# Contract: REST API — phần thêm ở Phase 2

Bổ sung cho `specs/002-phase-1-android-runner/contracts/rest-api.md` (quy ước lỗi, auth, tenant giữ nguyên). Trình duyệt gọi qua tiền tố `/api` (proxy bỏ tiền tố; đổi path cookie `/auth` → `/api/auth` — research R2). DTO Zod trong `packages/shared/src/api`.

**Vai trò** (FR-002a, research R13): route đánh dấu ✍ cần `owner`/`admin`/`member`; `viewer` nhận `403 { error: { code: "forbidden" } }`. Áp dụng cả cho route Phase 1 có ghi: `POST /runs`, `POST /runs/:id/cancel`, `POST /projects/:id/testcases`, `PUT /testcases/:id`, `PUT /projects/:id/popups`, `POST /apps/:id/builds`, `POST /agents`, `POST /agents/:id/revoke`.

## Thiết bị

| Method | Path | Body → Response |
|---|---|---|
| GET | `/devices` | như Phase 1 + `{ activity: { kind: "idle"\|"run"\|"live"\|"recording"\|"offline", by?: { user_id, name }, run_id?, since? } }` |
| POST ✍ | `/devices/:id/control` | → 201 `{ live_session_id, device_id, expires_at, idle_timeout_ms }`; 409 `device_busy` `{ activity }` (run, người khác điều khiển/ghi); 409 `device_offline` |
| DELETE ✍ | `/devices/:id/control` | chỉ người giữ phiên → 204; người khác → 403 |
| GET | `/devices/:id/control` | → phiên hiện tại hoặc 404 |

Lệnh điều khiển đi qua `/ws/ui` (`live.command`), không qua REST (contracts/ui-ws.md).

## Recorder

| Method | Path | Body → Response |
|---|---|---|
| POST ✍ | `/recordings` | `{ project_id, app_id, build_id, device_id }` → 201 `Recording` (status `recording`, bước `s1 launch` đã ghi). Lấy lease `recording` (409 `device_busy` như trên), cài build nếu khác bản trên máy, `pm clear`, mở app, chờ ổn định. Người đang điều khiển chính thiết bị đó được chuyển thẳng sang phiên ghi (`end_reason = replaced_by_recording`). |
| GET | `/recordings?project_id&status` | → Recording[] (không kèm `steps`) |
| GET | `/recordings/:id` | → `Recording` đủ `steps` (§3 data-model) + URL presigned GET cho snapshot từng step |
| PATCH ✍ | `/recordings/:id` | `{ intent?, slug?, steps?: RecordingStep[] }` — sửa/xóa/sắp xếp step, chấp nhận/bỏ đề xuất kỳ vọng; `steps` phải qua Zod step của `coral/testcase@1` → 200 Recording |
| POST ✍ | `/recordings/:id/stop` | thả lease → `stopped` |
| POST ✍ | `/recordings/:id/resume` | lấy lại lease (409 nếu bận) → `recording` |
| GET | `/recordings/:id/yaml` | → `{ yaml, warnings }` sinh từ steps + intent + slug (để xem trước) |
| POST ✍ | `/recordings/:id/save` | `{ slug, intent, yaml }` → 201 `{ test_case_id, head_commit, warnings }`: validate như Phase 1 + ảnh tham chiếu phải có; một commit gồm YAML + `snap/<slug>/**`; 409 `slug_exists` nếu slug có và không kèm `replace: true, base_commit` |
| DELETE ✍ | `/recordings/:id` | → 204 (`discarded`, xóa object S3) |

`Recording` = `{ id, project_id, app_id, build_id, device_id, status, intent, slug, steps?, created_by: { id, name }, created_at, updated_at, expires_at, test_case_id? }`.

## Test case và editor (bổ sung)

| Method | Path | Body → Response |
|---|---|---|
| GET | `/testcases/:id/snapshots` | → `[{ step_id, screen_url, tree_url, element_url }]` từ `snap/<slug>/` tại `head_commit` (URL tới route file bên dưới, cần access token) |
| GET | `/testcases/:id/files/*path` | nội dung một file trong repo tại `?commit=` (mặc định head), chỉ trong `snap/<slug>/`; `Content-Type` theo đuôi — dùng cho ảnh preview trong editor (FR-019) |
| GET | `/testcases/:id/last-run-steps` | → ảnh step của lần chạy gần nhất có test case này: `[{ step_id, screenshot_url, run_id, finished_at }]` — fallback khi chưa có snapshot (FR-019) |

`POST /projects/:id/testcases` và `PUT /testcases/:id`: kiểm tra thêm ảnh tham chiếu (`image`) phải có trong repo tại commit đó → 400 `validation_failed` code `image_not_found` (FR-022).

## Run (bổ sung)

`GET /runs` thêm lọc `?device_id&test_case_id`. Sự kiện thay đổi đẩy qua `/ws/ui` (`run.updated`, `run.step`); REST giữ nguyên.
