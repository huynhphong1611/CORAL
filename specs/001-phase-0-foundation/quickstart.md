# Quickstart: Phase 0 — chạy và kiểm tra DoD

## Yêu cầu
- Node.js 24 (`.nvmrc`), `corepack enable` (pnpm được ghim trong `package.json#packageManager`)
- Docker (chỉ cần cho hạ tầng; `pnpm dev` không cần)

## Chạy
```bash
cp .env.example .env          # tùy chọn — không có .env thì dùng mặc định
pnpm install
pnpm dev                      # server :3000, web :5173, agent
```

Kiểm tra:
```bash
curl -s localhost:3000/health          # {"status":"ok","service":"coral-server",...}
curl -s localhost:5173/api/health      # cùng payload qua proxy của Vite
```
Log agent phải có `server reachable`. Tắt server → agent ghi đúng một cảnh báo `server unreachable`; bật lại → `server reachable`.

## Cổng chất lượng
```bash
pnpm format:check && pnpm lint && pnpm check:boundaries && pnpm typecheck && pnpm test && pnpm build
```

Thử luật P1 (phải thất bại, rồi hoàn tác):
```bash
pnpm --filter @coral/agent add openai && pnpm check:boundaries   # exit 1
pnpm --filter @coral/agent remove openai
```

## Hạ tầng
```bash
docker compose up -d --wait    # postgres, redis, minio → healthy
docker compose ps
docker compose down            # thêm -v để xóa volume
```
MinIO console: http://localhost:9001 (user/pass trong `.env`, mặc định `coral` / `coral-dev-secret`).

## Checklist DoD Phase 0
- [x] `pnpm install && pnpm dev` khởi động server, web, agent
- [x] `pnpm test` xanh
- [x] `docker compose up -d` chạy đủ 3 dịch vụ
- [ ] CI xanh (job `checks` và `infra`)
