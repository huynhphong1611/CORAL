# Contract: `WS /ws/ui` — phần thêm ở Phase 3

Envelope, xác thực `ui.auth` (D38) và các message của Phase 2 giữ nguyên (`specs/003-phase-2-web-recorder/contracts/ui-ws.md`). Schema ở `packages/shared/src/protocol/ui.ts`. Mọi đăng ký kiểm tenant (P5): id của tenant khác → `error` `not_found`.

| Hướng | type | payload |
|---|---|---|
| C→S | `exploration.watch` | `{ exploration_id }` |
| C→S | `exploration.unwatch` | `{ exploration_id }` |
| S→C | `exploration.updated` | `{ exploration_id, status, stop_reason?, stats, current?: { n, screen_name?, action_summary } }` — mỗi khi trạng thái hoặc số liệu đổi |
| S→C | `exploration.step` | `{ exploration_id, step: ExplorationStep }` — ngay sau khi bước được ghi (SC-011: ≤ 3 s sau thao tác) |
| S→C | `exploration.screen` | `{ exploration_id, screen: { id, name, fingerprint, is_new } }` — khi gặp màn hình mới hoặc đặt tên xong |
| C→S | `import.watch` | `{ import_job_id }` |
| C→S | `import.unwatch` | `{ import_job_id }` |
| S→C | `import.updated` | `{ import_job_id, status, stats: { total, done, active, draft, not_processed, cost_usd }, item?: { n, status, reason? } }` |

- `ExplorationStep` giống response của `GET /explorations/:id/steps` (contracts/rest-api-phase3.md); ảnh là URL presigned 15 phút.
- `devices.updated` của Phase 2: `activity.kind` nhận thêm `exploration` (kèm `by`, `exploration_id`), để trang thiết bị hiện "Exploring by <tên>".
- Bấm dừng dùng REST (`POST /explorations/:id/stop`), không qua WS.
