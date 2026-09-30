# Feature Specification: Phase 1 — Runner tất định trên Android + server tối thiểu

**Feature Branch**: `002-phase-1-android-runner` (làm trên nhánh `claude/phase-0-planning-tech-stack-6m4j5c`)

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Phase 1 — Runner tất định trên Android + server tối thiểu (docs/ROADMAP.md Phase 1). Mục tiêu: chạy một test case YAML viết tay trên Android emulator thông qua server, không dùng AI. Phạm vi theo ROADMAP Phase 1 và SPEC §5.3, §6, §7, §8, §9.1–9.2, §9.4, §15, §17, các quyết định D08–D28. Android dùng thẳng UiAutomator2 (D27). Runner tách UiDriver + TargetLifecycle (D28). DoD: test case đăng nhập viết tay trên app mẫu chạy qua server pass 5/5 lần liên tiếp; kết quả và screenshot từng step truy xuất được qua API; unit test resolver locator với fixture cây element giả; popup quyền Android được guard xử lý khi không cấp quyền trước."

## User Scenarios & Testing *(mandatory)*

Vai trò trong phase này:
- **Người viết test** (QA/dev): viết file test case YAML theo SPEC §7.
- **Người vận hành** (Huynh): tài khoản seed duy nhất, điều khiển coral qua API.
- **Agent**: tiến trình chạy trên máy có Android emulator/thiết bị, kết nối ra server.

### User Story 1 - Kiểm tra file test case trước khi chạy (Priority: P1)

Người viết test chạy lệnh kiểm tra trên một file test case và biết ngay file có hợp lệ không; nếu sai, thông báo chỉ rõ file, step và trường bị lỗi. Không cần thiết bị.

**Why this priority**: Mọi luồng chạy khác đều bắt đầu từ một file hợp lệ; lỗi định dạng phải bị chặn trước khi tốn thời gian thiết bị.

**Independent Test**: Chạy lệnh kiểm tra trên các file trong `examples/` (phải hợp lệ) và trên một bộ file lỗi mẫu (phải báo lỗi đúng chỗ) — không cần emulator.

**Acceptance Scenarios**:

1. **Given** file `examples/testcase.example.yaml`, **When** chạy lệnh kiểm tra, **Then** kết quả hợp lệ, mã thoát 0.
2. **Given** một file thiếu `intent` hoặc step `tap` không có `target`, **When** chạy lệnh kiểm tra, **Then** báo lỗi nêu tên file, `id` của step và tên trường, mã thoát khác 0.
3. **Given** file khai báo `platforms: [android, ios]` nhưng một `target` chỉ có locator iOS, **When** kiểm tra, **Then** báo lỗi thiếu locator cho Android ở đúng step đó.
4. **Given** file dùng `${var:x}` chưa khai báo trong `variables` hoặc quyền không có trong danh sách §7.5, **When** kiểm tra, **Then** báo lỗi tương ứng.

---

### User Story 2 - Chạy một test case trên emulator ngay tại máy (Priority: P1)

Người viết test chạy một file test case trên emulator/thiết bị Android đang cắm vào máy mình, không cần server. Hệ thống chuẩn bị app theo `preconditions`, chạy từng step không dùng AI, rồi cho kết quả pass/fail kèm ảnh chụp và cây element của từng step trong một thư mục cục bộ.

**Why this priority**: Đây là vòng lặp dev nhanh nhất để làm đúng runner (tìm element, thao tác, kiểm tra kỳ vọng) trước khi ghép với server.

**Independent Test**: Với app mẫu đã cài trên emulator, chạy test case đăng nhập tham chiếu bằng lệnh cục bộ → pass; thư mục kết quả có ảnh chụp + cây element cho mọi step.

**Acceptance Scenarios**:

1. **Given** emulator đang chạy và test case đăng nhập hợp lệ, **When** chạy lệnh cục bộ với id thiết bị, **Then** mọi step pass, kết quả tổng là pass, mỗi step có ảnh chụp, cây element, locator đã dùng và thời gian.
2. **Given** `preconditions.app_state: fresh`, **When** chạy, **Then** dữ liệu app bị xóa trước khi chạy (màn hình đầu là màn đăng nhập dù lần trước đã đăng nhập).
3. **Given** locator ưu tiên cao nhất (id) không còn khớp nhưng locator text vẫn khớp, **When** chạy, **Then** step vẫn pass và được đánh dấu `degraded` kèm vị trí locator đã dùng.
4. **Given** target không xuất hiện trong thời gian chờ, **When** chạy, **Then** step fail với mã `TARGET_NOT_FOUND`, test case dừng ở step đó, artifact của step lỗi có thêm đoạn log thiết bị.
5. **Given** test case tham chiếu `${secret:TEST_PASSWORD}` mà biến môi trường tương ứng không có, **When** chạy, **Then** hệ thống dừng trước khi thao tác thiết bị và báo thiếu secret nào.

---

### User Story 3 - Chạy test case thông qua server (Priority: P1) 🎯 DoD

Người vận hành đăng nhập bằng tài khoản seed, tạo project, app, tải lên bản build, lưu test case và luật popup vào project, tạo agent và lấy token. Agent trên máy có emulator kết nối ra server và báo danh sách thiết bị. Người vận hành tạo một run (build + thiết bị + test case đã lưu); server xếp hàng, giao cho agent khi thiết bị rảnh; agent chạy và gửi kết quả từng step; người vận hành xem trạng thái, kết quả và ảnh chụp từng step qua API.

**Why this priority**: Đây chính là DoD của Phase 1 và là xương sống cho mọi phase sau (web UI, Explorer, Healer đều đi qua luồng run này).

**Independent Test**: Chạy luồng trên 5 lần liên tiếp với test case đăng nhập trên app mẫu → 5/5 pass; với mỗi run, lấy được danh sách step và tải được ảnh chụp từng step qua API.

**Acceptance Scenarios**:

1. **Given** một file test case hợp lệ, **When** người vận hành lưu nó vào project, **Then** hệ thống ghi thành một phiên bản mới có lịch sử; lưu lại nội dung sửa đổi tạo phiên bản tiếp theo; nội dung không hợp lệ bị từ chối với lỗi như US1.
2. **Given** agent đã kết nối bằng token hợp lệ, **When** người vận hành liệt kê thiết bị, **Then** thấy emulator với nền tảng, model, phiên bản OS và trạng thái `idle`.
3. **Given** một run được tạo cho thiết bị đang `idle`, **When** server giao việc, **Then** thiết bị chuyển `leased`, agent xác nhận nhận việc, và sau khi xong thiết bị trở về `idle`.
4. **Given** run đang chạy, **When** người vận hành xem chi tiết run, **Then** thấy trạng thái từng step cập nhật dần (không phải đợi hết run).
5. **Given** run đã xong, **When** người vận hành xem từng step, **Then** mỗi step có trạng thái, locator đã dùng, `degraded`, thời gian, và liên kết tải ảnh chụp/cây element có hạn dùng ngắn.
6. **Given** hai run cùng nhắm một thiết bị, **When** cả hai được tạo gần như cùng lúc, **Then** chúng chạy lần lượt, không bao giờ chồng lên nhau.
7. **Given** run đang chạy, **When** người vận hành hủy run, **Then** agent dừng sau thao tác hiện tại, dọn dẹp tối thiểu (khôi phục cài đặt animation trên máy thật, dừng server điều khiển; không gỡ app, không xóa dữ liệu — dọn dẹp đầy đủ ở Phase 5), run chuyển `cancelled` và thiết bị được trả lại.
8. **Given** agent mất kết nối giữa run, **When** quá 3 nhịp heartbeat, **Then** test case đang chạy fail với `DEVICE_OFFLINE`, thiết bị được giải phóng, không tự chạy lại.
9. **Given** token agent sai hoặc đã thu hồi, **When** agent kết nối, **Then** bị từ chối và không nhận được việc nào.

---

### User Story 4 - Popup không làm hỏng test (Priority: P2)

Khi app bật hộp thoại xin quyền (hoặc popup đã có luật như "đánh giá app") mà test không cấp quyền trước, hệ thống tự nhận ra popup, bấm nút phù hợp theo luật popup của project rồi làm tiếp step — trừ khi chính step đó đang kiểm tra popup ấy.

**Why this priority**: Là một mục DoD và là nguyên nhân gãy test phổ biến nhất trên mobile; nhưng chỉ có giá trị khi luồng chạy (US2/US3) đã có.

**Independent Test**: Chạy một test case mở màn hình cần quyền runtime trên app mẫu, **không** cấp quyền trước → test pass nhờ guard; artifact ghi lại popup đã xử lý và luật đã dùng.

**Acceptance Scenarios**:

1. **Given** quyền chưa được cấp và app bật hộp thoại xin quyền của hệ thống, **When** step kế tiếp không tìm thấy target, **Then** guard bấm nút cho phép theo luật `android_permission`, rồi step được thử lại và pass.
2. **Given** popup chỉ có các nút thuộc `never_tap`, **When** guard xử lý, **Then** không bấm nút nào và step fail với `BLOCKED_BY_POPUP`.
3. **Given** step hiện tại có target nằm trong chính popup (đang test luồng xin quyền), **When** popup hiện, **Then** guard không đóng popup.
4. **Given** 4 popup liên tiếp trong một step, **When** guard đã xử lý 3 cái, **Then** step fail với `BLOCKED_BY_POPUP`.
5. **Given** chỉ có toast/snackbar, **When** chạy step, **Then** guard bỏ qua, không coi là popup chặn.
6. **Given** hộp thoại "ứng dụng không phản hồi" hoặc báo crash của hệ thống, **When** gặp, **Then** guard không đóng nó; test fail với `APP_NOT_RESPONDING` / `APP_CRASHED` kèm log thiết bị.

---

### User Story 5 - Kết quả an toàn và đủ để chẩn đoán (Priority: P2)

Mỗi step lưu đủ bằng chứng (ảnh chụp, cây element, locator đã dùng, thời gian, log thiết bị khi lỗi) theo tenant, và không bao giờ lộ giá trị secret trong log, kết quả hay artifact dạng text.

**Why this priority**: Bằng chứng này là đầu vào cho Healer (Phase 4) và cho người debug; lộ secret là rủi ro bảo mật.

**Independent Test**: Chạy test case đăng nhập (có secret), rồi quét toàn bộ log, kết quả step và artifact text → không có giá trị secret; mọi artifact nằm trong vùng lưu riêng của tenant.

**Acceptance Scenarios**:

1. **Given** step `type` với giá trị lấy từ secret, **When** chạy xong, **Then** log, kết quả step và cây element lưu lại hiển thị `***` thay cho giá trị.
2. **Given** step fail, **When** xem artifact, **Then** có thêm đoạn log thiết bị gần thời điểm lỗi.
3. **Given** một run bất kỳ, **When** liệt kê artifact, **Then** mọi artifact nằm trong vùng lưu riêng của tenant sở hữu run.

### Edge Cases

- Màn hình không bao giờ ổn định (video, animation vô hạn): sau thời gian chờ ổn định tối đa, runner vẫn làm tiếp và ghi chú "không ổn định" vào step.
- Target có trong cây element nhưng nằm ngoài màn hình hoặc bị phủ: coi như không thao tác được — gọi guard; vẫn bị phủ thì fail, không bấm nhầm vào lớp phủ.
- Target nằm dưới bàn phím ảo: step fail rõ ràng; người viết test dùng `hide_keyboard` hoặc `scroll_to` (không tự đoán).
- Nhập text tiếng Việt có dấu / Unicode: giá trị gõ vào phải đúng từng ký tự.
- App crash giữa chừng: fail `APP_CRASHED`, kèm log; test case dừng, các test case sau trong cùng run vẫn chạy (app được mở lại theo `preconditions`).
- Thiết bị bị rút / emulator tắt giữa run: fail `DEVICE_OFFLINE` hoặc `DRIVER_ERROR`, lease được giải phóng.
- Cài build thất bại (sai kiến trúc, thiếu dung lượng): test case fail `DRIVER_ERROR` với lý do; không chạy step nào.
- Run tạo cho thiết bị đang offline: nằm trong hàng đợi tối đa thời gian chờ hàng đợi rồi fail, không treo vô hạn.
- Test case không khai báo `android` trong `platforms`: bị từ chối khi tạo run trên thiết bị Android và khi chạy cục bộ.
- Message không hợp lệ giữa agent và server: bị từ chối, ghi log, không làm sập bên nào.

## Requirements *(mandatory)*

### Functional Requirements

**Định dạng & kiểm tra test case**

- **FR-001**: Hệ thống MUST đọc file test case theo định dạng `coral/testcase@1` (SPEC §7, gồm tham số từng action §7.1) và từ chối file sai với thông báo nêu file, `id` step và trường lỗi.
- **FR-002**: Việc kiểm tra MUST bao gồm: `intent` bắt buộc; tham số đúng theo action; loại locator hợp lệ; `${var:…}` đã khai báo; tên quyền thuộc danh sách §7.5; mỗi `target`/locator trong `expect` có ít nhất một locator áp dụng được cho từng nền tảng khai báo.
- **FR-003**: Mọi file trong `examples/` MUST hợp lệ; định dạng `coral/popups@1` (SPEC §9.2) cũng MUST được kiểm tra tương tự.

**Chạy test case (không AI)**

- **FR-004**: Người viết test MUST chạy được một file test case trên một thiết bị Android chỉ định mà không cần server, nhận kết quả pass/fail và artifact từng step trong thư mục cục bộ.
- **FR-005**: Hệ thống MUST hỗ trợ trên Android mọi action ở §7.1 và các locator `android_id`, `text`, `text_contains`, `desc`, `rel`, `class_index`, `point_pct` (§7.2), thử theo thứ tự khai báo và bỏ qua locator của nền tảng khác.
- **FR-006**: Trước mỗi step, hệ thống MUST chờ màn hình ổn định bằng cách so sánh cấu trúc cây element (không dùng thời gian chờ cố định), có giới hạn thời gian (§8.3).
- **FR-007**: Mọi thao tác chạm MUST nhắm vào tâm vị trí **đọc lúc chạy** của element; trước khi chạm MUST xác nhận element ở lớp trên cùng tại điểm đó (§8.4). `point_pct` chỉ dùng khi mọi locator khác không khớp.
- **FR-008**: Hệ thống MUST kiểm tra `expect` (`visible_text`, `visible`, `not_visible`, danh sách điều kiện) trong `timeout_ms`, mặc định 5000 ms (§7.3).
- **FR-009**: Step tìm thấy bằng locator không phải locator đầu tiên áp dụng được MUST được đánh dấu `degraded` kèm vị trí locator đã dùng (§8.7).
- **FR-010**: Step lỗi MUST mang một mã lỗi ở §8.5; test case dừng ở step lỗi đầu tiên.
- **FR-011**: Mỗi step MUST lưu ảnh chụp, cây element, locator đã dùng và thời gian; step lỗi MUST lưu thêm đoạn log thiết bị (§8.6).
- **FR-012**: Trước mỗi test case, hệ thống MUST chuẩn bị thiết bị: cài build nếu chưa có hoặc khác bản, áp `app_state`, cấp các quyền trong `grant_permissions`, tắt animation (§8.3, §9.1); MUST NOT làm thao tác phá hủy ngoài app đang test (P6).
- **FR-013**: Secret MUST được thay giá trị lúc chạy (trước Phase 5: từ biến môi trường của máy chạy, D19); thiếu secret thì dừng trước khi động vào thiết bị; giá trị secret MUST được che `***` trong mọi log, kết quả và artifact dạng text.
- **FR-014**: Runner và agent MUST hoạt động khi không có bất kỳ nhà cung cấp AI nào (P1).

**Popup guard (lớp 2)**

- **FR-015**: Hệ thống MUST phát hiện popup chặn (hộp thoại thuộc package khác app, dialog đè lên app) ngay sau khi mở app, khi không tìm thấy target và khi `expect` thất bại; so khớp với luật popup của run và bấm nút theo luật, rồi thử lại step (§9.2).
- **FR-016**: Guard MUST NOT bấm nút thuộc `never_tap` (§9.4), MUST NOT đóng popup mà step hiện tại đang nhắm tới, MUST NOT đóng hộp thoại crash/ANR, bỏ qua toast/snackbar, và xử lý tối đa 3 popup mỗi step rồi fail `BLOCKED_BY_POPUP` (D25).

**Server tối thiểu**

- **FR-017**: Người vận hành MUST đăng nhập được bằng tài khoản seed và nhận token truy cập ngắn hạn; mọi API trừ `/health`, `/health/ready` và `/auth/*` (đăng nhập, làm mới, đăng xuất) MUST yêu cầu xác thực; `/health/ready` chỉ trả trạng thái sẵn sàng, không lộ chi tiết hạ tầng.
- **FR-018**: Mọi bản ghi nghiệp vụ MUST gắn tenant và mọi truy cập dữ liệu MUST lọc theo tenant của người gọi (P5, D10).
- **FR-019**: Người vận hành MUST tạo được project, app Android (theo package), và tải lên build kèm checksum; build lưu trong kho artifact theo vùng riêng của tenant.
- **FR-020**: Người vận hành MUST tạo được agent và nhận token **một lần**; hệ thống chỉ lưu dạng băm; token thu hồi được.
- **FR-021**: Agent MUST tự kết nối ra server bằng token, báo phiên bản, OS, khả năng và danh sách thiết bị; cập nhật khi thiết bị thêm/bớt/đổi trạng thái; heartbeat 15 giây, mất 3 nhịp thì offline (§15).
- **FR-022**: Người vận hành MUST tạo được run gồm build, thiết bị, một hoặc nhiều test case và luật popup; run được xếp hàng và giao khi thiết bị rảnh, giữ lease độc quyền, có timeout và hủy được (D16).
- **FR-023**: Agent MUST gửi kết quả từng step ngay khi xong và tải artifact thẳng lên kho artifact bằng quyền ghi ngắn hạn do server cấp; server lưu trạng thái run / test case / step.
- **FR-024**: Người vận hành MUST xem được danh sách run, chi tiết run, từng test case trong run và từng step kèm liên kết tải artifact có hạn dùng ngắn.
- **FR-025**: Agent chỉ MUST nhận việc của tenant sở hữu nó; agent mất kết nối giữa run thì test case đang chạy fail `DEVICE_OFFLINE`, lease giải phóng, không tự chạy lại.
- **FR-026**: Mọi message agent ↔ server MUST được kiểm tra định dạng; message sai bị từ chối và ghi log, không làm sập bên nhận; message trả lời MUST tham chiếu message nó trả lời (D18).
- **FR-027**: Test case và luật popup MUST được tạo và lưu **trong chính hệ thống**, trong kho có lịch sử phiên bản của project (SPEC §13.1, D15, D31). Người vận hành MUST thêm, sửa, liệt kê và xem được test case và luật popup; nội dung được kiểm tra như FR-001–FR-003 khi lưu; mỗi lần sửa tạo một phiên bản mới.
- **FR-028**: Run MUST tham chiếu test case đã lưu, và mỗi test case trong run MUST ghi lại đúng phiên bản đã chạy, để kết quả luôn truy ngược được về nội dung đã dùng.
- **FR-029**: Test case viết tay MUST được đánh dấu nguồn `manual`; trạng thái mặc định `draft`; ở phase này run chạy được test case ở mọi trạng thái.

### Key Entities *(include if feature involves data)*

- **Tenant / User / Membership**: một tenant và một user seed; user thuộc tenant qua membership với vai trò `owner`.
- **Project**: nhóm app + test case của một sản phẩm.
- **App**: ứng dụng Android xác định bằng package, thuộc project.
- **Build**: một bản APK của app: phiên bản, checksum, vị trí lưu, người tải lên.
- **Agent**: tiến trình cạnh thiết bị, thuộc một tenant; token (băm), OS, khả năng, lần thấy cuối, trạng thái.
- **Device**: thiết bị/emulator do agent quản lý: nền tảng, loại, model, phiên bản OS, id thiết bị, trạng thái `idle`/`leased`/`offline`.
- **Lease**: quyền dùng độc quyền một thiết bị cho một run, có hạn và thời điểm giải phóng.
- **Run**: một lần chạy một hoặc nhiều test case trên một thiết bị với một build; nguồn kích hoạt, trạng thái, thời gian.
- **Run item**: một test case trong run: phiên bản test case đã chạy, trạng thái, mã lỗi.
- **Run step**: kết quả một step: trạng thái, locator đã dùng, `degraded`, thời gian, nơi lưu artifact.
- **Test case**: nội dung YAML theo §7, lưu trong kho có lịch sử của project; bản ghi chỉ mục gồm slug, intent, tags, trạng thái, phiên bản mới nhất, nguồn (`manual` ở phase này).
- **Popup rules**: nội dung theo §9.2, một bộ cho mỗi project, cũng có lịch sử phiên bản.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Test case đăng nhập tham chiếu trên app mẫu, chạy qua server, pass **5/5 lần liên tiếp** trên emulator tham chiếu.
- **SC-002**: Với mỗi run đã xong, 100% step có ảnh chụp và cây element tải được qua API, sẵn sàng trong vòng 10 giây sau khi run kết thúc.
- **SC-003**: Test case mở màn hình cần quyền runtime, **không** cấp quyền trước, pass 5/5 lần nhờ guard.
- **SC-004**: Logic tìm element được kiểm chứng bằng test tự động không cần thiết bị: mỗi loại locator trong phạm vi có ít nhất một ca khớp và một ca rơi xuống locator dự phòng; chạy tự động ở mỗi lần đẩy code.
- **SC-005**: Test case đăng nhập tham chiếu (khoảng 10 step) chạy xong dưới 60 giây kể cả mở app, trên emulator tham chiếu.
- **SC-006**: 100% file trong bộ file lỗi mẫu bị kiểm tra phát hiện, mỗi lỗi chỉ đúng step và trường.
- **SC-007**: Với 10 run tạo đồng thời cho cùng một thiết bị, không có hai run nào chạy chồng lên nhau.
- **SC-008**: Quét toàn bộ log, kết quả và artifact text của run tham chiếu: 0 lần xuất hiện giá trị secret.
- **SC-009**: Agent mất kết nối giữa run → test case đang chạy được đánh dấu `DEVICE_OFFLINE` và thiết bị được giải phóng trong vòng 60 giây.
- **SC-010**: Chạy test case vẫn thành công khi mọi nhà cung cấp AI đều không truy cập được.

## Assumptions

- **App mẫu tham chiếu**: Sauce Labs My Demo App bản Android (có màn đăng nhập với tài khoản demo công khai và màn cần quyền runtime, ví dụ quét QR cần camera). Tài khoản demo vẫn được cấp qua `${secret:…}` để kiểm chứng việc che secret.
- **Emulator tham chiếu**: Android 14 (API 34), image x86_64 Google APIs, chạy trên máy Linux hoặc Windows + WSL2 theo ROADMAP. Chỉ Android 14 được kiểm chứng ở phase này; Android 9–13 (API 28–33) là best-effort — dự kiến chạy được nhưng chưa có test thiết bị.
- **Driver Android**: theo D27 (điều khiển trực tiếp qua UiAutomator2, không Appium); kiến trúc driver theo D28 để mở rộng sau này. Đây là ràng buộc kỹ thuật đã chốt, chi tiết để ở `plan.md`.
- **Một tenant**: phase này chỉ có một tenant và một user seed, nhưng dữ liệu vẫn gắn tenant; đăng ký, mời thành viên, RLS ở Phase 5.
- **Không có web UI**: tương tác qua API và dòng lệnh; màn hình web ở Phase 2.
- **Nguồn test case**: mọi test case sinh ra trong coral (D31). Phase 1 chỉ có test case **viết tay** lưu qua API; tạo từ prompt và import test case thủ công (CSV/Excel/Gherkin) do AI chuyển đổi làm ở Phase 3; editor + Recorder ở Phase 2.
- **Ngoài phạm vi Phase 1**: locator `image` (Phase 2), `expect.screen` (cần app map — Phase 3; bị báo "chưa hỗ trợ" khi kiểm tra), iOS (Phase 5), live view / recorder (Phase 2), mọi tính năng AI, tự động chạy lại khi lỗi.
- **Mặc định vận hành**: timeout hàng đợi 10 phút, timeout cả run 30 phút, giữ artifact 30 ngày (cấu hình được).
- **Một thiết bị nhiều run**: chạy lần lượt; nhiều thiết bị trên cùng agent chạy song song được.

## Clarifications

### Session 2026-09-28

- Q: Khi chạy qua server, test case lấy từ đâu? → A: Test case được tạo và lưu trong chính coral. Phase 1 làm kho git tối thiểu của project (API thêm/sửa/xem test case và `popups.yaml`, mỗi lần sửa là một commit); run tham chiếu test case + commit. Về sau user còn tạo test case bằng prompt hoặc import rất nhiều test case thủ công sẵn có để AI khám phá và chuyển thành test case coral (Phase 3, D31).
