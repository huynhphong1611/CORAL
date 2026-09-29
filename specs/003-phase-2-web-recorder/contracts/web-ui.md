# Contract: màn hình web (Phase 2)

UI tiếng Anh (clarify Q1). Route khai báo bằng TanStack Router trong `apps/web/src/routes/`. Mọi trang trừ `/login` cần phiên; hết phiên → `/login?next=…`. Vai trò `viewer`: các nút ghi/điều khiển/chạy bị ẩn **và** server từ chối (FR-002a).

| Route | Màn hình | Nội dung chính | User story |
|---|---|---|---|
| `/login` | Sign in | email, password; lỗi chung "Invalid email or password" | US1 |
| `/` | Home | chuyển tới `/projects` | — |
| `/projects` | Projects | danh sách project; tạo project ✍ | US1 |
| `/projects/$projectId` | Project | tab **Test cases** (slug, intent, status, source, updated) · **Apps & builds** (tạo app, tải APK ✍ — US7) · **Runs** (của project) · **Recordings** (bản ghi dở) | US1, US7 |
| `/projects/$projectId/testcases/$testCaseId` | Test case editor | CodeMirror YAML + lint trực tiếp (dòng/cột, step, mã lỗi); cột phải: ảnh từng step (snapshot hoặc lần chạy gần nhất, "No image yet"); nút **Save** ✍ (khóa khi có lỗi), **History**, **Run** ✍ (chọn build + thiết bị) | US5, US1 |
| `/devices` | Devices | bảng thiết bị: model, OS, agent, trạng thái (`idle`, `busy · run …`, `controlled by …`, `recording by …`, `offline`); tạo agent token ✍ (hiện một lần, nút Copy — US7) | US1, US7 |
| `/devices/$deviceId` | Live device | canvas live view; thanh trạng thái (fps, `stalled`); nút **Take control** ✍ / **Release**; khi điều khiển: click = tap, kéo = swipe, giữ ≥ 500 ms = long press; nút Back, Home, Hide keyboard, Restart app; ô **Type text** + Enter; ô mật khẩu → chọn secret; bộ đếm thời gian tự thả | US2, US3 |
| `/projects/$projectId/record?device=…&app=…&build=…` → `/recordings/$recordingId` | Recorder | trái: live view (như trên, thêm chế độ **Assert**: click chọn element → thêm `visible`/`visible_text`/`not_visible`); phải: danh sách step (ảnh nhỏ, action, locator đầu, cảnh báo), **đề xuất kỳ vọng** dạng chip bấm để thêm (FR-013a), xóa/kéo sắp xếp step; dưới: slug, intent, **Preview YAML**, **Save as test case** ✍ | US4 |
| `/runs` | Runs | danh sách run (lọc project, trạng thái, thiết bị); cập nhật trực tiếp | US1 |
| `/runs/$runId` | Run detail | tiến trình từng item/step trực tiếp; mỗi step: ảnh, trạng thái, locator đã dùng (`degraded`), thời gian, popup đã xử lý, lỗi + device log; mở `tree.json` dạng cây | US1 |

## Hành vi chung

- Trạng thái tải / trống / lỗi cho mọi danh sách; lỗi API hiện `message` của server.
- Live view: khung mới thay khung cũ; không khung > 5 s → lớp phủ "Connection lost — reconnecting"; tự đăng ký lại khi WS nối lại.
- Bản ghi dở luôn ở server (FR-016): tải lại trang `/recordings/$id` khôi phục đủ step.
- Mọi ảnh step dùng URL presigned; ảnh hỏng → khung "Image unavailable".
