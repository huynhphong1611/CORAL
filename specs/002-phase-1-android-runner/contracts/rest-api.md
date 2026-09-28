# Contract: REST API (Phase 1)

Nguồn: SPEC §16, §17, D12, D23. Mọi JSON dùng `snake_case`; request/response được validate bằng Zod trong `packages/shared/src/api`. Tất cả route trừ `/health` và `/auth/*` cần `Authorization: Bearer <access_token>`; mọi truy vấn giới hạn trong tenant của token.

## Lỗi

```json
{ "error": { "code": "validation_failed", "message": "…", "details": [ { "path": "steps[2].target", "code": "platform_coverage", "message": "…" } ] } }
```
Mã HTTP: 400 (JSON sai), 401, 403, 404 (không có **hoặc thuộc tenant khác**), 409 (trùng), 413 (build quá lớn, mặc định 500 MB), 422 (vi phạm nghiệp vụ, ví dụ thiếu secret).

## Auth

| Method | Path | Body → Response |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → `{ access_token, expires_in, user: { id, email, name }, tenant: { id, name, role } }` + cookie `coral_refresh` (thêm `refresh_token` trong body nếu header `X-Coral-Client: cli`) |
| POST | `/auth/refresh` | cookie hoặc `{ refresh_token }` → như login; token cũ bị thu hồi (xoay vòng) |
| POST | `/auth/logout` | thu hồi refresh token hiện tại → 204 |
| GET | `/me` | → `{ user, tenant }` |

Giới hạn: 10 lần login sai / 15 phút / email.

## Project, app, build

| Method | Path | Body → Response |
|---|---|---|
| GET/POST | `/projects` | `{ name }` → `{ id, name, created_at }` (tạo kho git + `popups.yaml` mặc định) |
| GET/POST | `/projects/:id/apps` | `{ platform: "android", package_or_bundle_id, name }` → App |
| POST | `/apps/:id/builds` | multipart: `file` (.apk), `version` → `{ id, version, checksum_sha256, size_bytes, created_at }` |
| GET | `/apps/:id/builds` | → Build[] |

## Test case và luật popup (D15, D31)

| Method | Path | Body → Response |
|---|---|---|
| GET | `/projects/:id/testcases` | → `[{ id, slug, intent, tags, platforms, status, head_commit, source, updated_at }]` |
| POST | `/projects/:id/testcases` | `{ yaml }` → 201 `{ id, slug, head_commit, warnings: [] }`; 409 nếu slug đã có; 400 `validation_failed` |
| GET | `/testcases/:id` | → `{ …index, yaml }` (tại `head_commit`); `?commit=<sha>` lấy phiên bản cũ |
| PUT | `/testcases/:id` | `{ yaml, base_commit }` → `{ head_commit, warnings }`; 409 nếu `base_commit` ≠ head (tránh ghi đè) |
| GET | `/testcases/:id/history` | → `[{ commit, author, message, created_at }]` |
| GET | `/projects/:id/popups` | → `{ yaml, head_commit }` |
| PUT | `/projects/:id/popups` | `{ yaml, base_commit }` → `{ head_commit }` |

## Agent và thiết bị

| Method | Path | Body → Response |
|---|---|---|
| POST | `/agents` | `{ name }` → 201 `{ id, name, token }` — **token chỉ trả một lần** |
| GET | `/agents` | → `[{ id, name, status, os, version, last_seen_at }]` |
| POST | `/agents/:id/revoke` | → 204; đóng kết nối đang mở |
| GET | `/devices` | → `[{ id, agent_id, platform, kind, model, os_version, api_level, udid, status }]` |

## Run

| Method | Path | Body → Response |
|---|---|---|
| POST | `/runs` | `{ project_id, build_id, device_id, test_case_ids: [..] }` → 201 `{ id, status: "queued", items: [{ id, test_case_id, commit, position }] }`; 422 `missing_secrets` / `platform_mismatch` / `device_not_android` |
| GET | `/runs` | `?project_id&status&limit&cursor` → `{ items: Run[], next_cursor }` |
| GET | `/runs/:id` | → `{ id, status, failure_code, device, build, queued_at, started_at, finished_at, items: [{ id, test_case_id, slug, commit, status, failure_code, failed_step_id }] }` |
| POST | `/runs/:id/cancel` | → 202 |
| GET | `/runs/:id/items/:itemId/steps` | → `[{ step_index, step_id, action, status, locator_used_index, degraded, unstable, duration_ms, failure_code, message, popups_handled, artifacts: { screenshot_url, tree_url, log_url } }]` — URL presigned, hạn 15 phút |

## Health

`GET /health` → `{ status, service, version, uptime_sec }` (không đổi so với Phase 0) — thêm `GET /health/ready` kiểm tra Postgres, Redis, S3, thư mục dữ liệu.
