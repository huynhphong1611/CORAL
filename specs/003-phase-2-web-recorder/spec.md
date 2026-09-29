# Feature Specification: Phase 2 — Web UI, live view, recorder

**Feature Branch**: `003-phase-2-web-recorder` (làm trên nhánh `claude/phase-0-planning-tech-stack-6m4j5c`)

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "Phase 2 — Web UI, live view, recorder (docs/ROADMAP.md Phase 2; SPEC §11.1 Recorder, §13 git repo project, §15 stream.* WS messages, §16 REST API, §7.2 locator image, D27). Goal: operate devices and record tests from the browser. Scope: (1) Web app (apps/web, React SPA): login, projects, devices, runs list and run detail with per-step screenshots; (2) Live view MVP: JPEG stream 2–5 fps over WebSocket binary frames (stream.* messages); (3) click on the live view maps to device coordinates and performs a real tap (requires a `live` lease on the device); (4) Recorder: hit-test the element at the clicked point, extract a full locator chain + crop image + snapshot, append a step to the editor; (5) YAML editor with per-step screenshot preview, saving to the project's git repo (§13, validate on save, each save is a commit); (6) `image` locator: template matching with OpenCV WASM inside packages/runner. DoD: record a 5-step flow from the web UI, save it as a test case, replay it 3/3 passing. Feature directory: specs/003-phase-2-web-recorder. Phase 1 is complete except device-only tasks, which now run on a CI Android emulator (.github/workflows/device.yml)."

## User Scenarios & Testing *(mandatory)*

Vai trò trong phase này:
- **Người dùng web** (QA/dev, Huynh): thành viên của một tenant, đăng nhập bằng trình duyệt trên máy tính. Phase 2 chưa phân quyền chi tiết: mọi thành viên của tenant đều xem và điều khiển được thiết bị của tenant đó.
- **Agent**: tiến trình trên máy có thiết bị Android (như Phase 1), nay thêm việc gửi hình màn hình và nhận lệnh điều khiển từ xa.

### User Story 1 - Xem project, thiết bị và kết quả run trên web (Priority: P1)

Người dùng đăng nhập trên trình duyệt, thấy danh sách project, thiết bị của tenant (đang rảnh / bận / offline), danh sách run gần đây và mở một run để xem từng step: trạng thái, locator đã dùng, thời gian, popup đã xử lý, ảnh chụp màn hình, cây element và log thiết bị của step lỗi. Từ một test case đã lưu, người dùng chọn build và thiết bị rồi bấm chạy, sau đó theo dõi run tới khi xong.

**Why this priority**: Đây là cửa vào của mọi tính năng web khác và thay thế việc gọi API bằng tay ở Phase 1; một mình nó đã có giá trị (xem kết quả run có ảnh).

**Independent Test**: Với server + agent (thiết bị thật hoặc giả lập) của Phase 1, đăng nhập web, mở một run đã có → thấy đủ step và ảnh; tạo run mới từ web → run chạy xong và hiện kết quả mà không cần gọi API bằng tay.

**Acceptance Scenarios**:

1. **Given** tài khoản hợp lệ, **When** đăng nhập trên web, **Then** vào được trang chính của tenant; đóng và mở lại trình duyệt trong thời hạn phiên thì không phải đăng nhập lại.
2. **Given** sai mật khẩu, **When** đăng nhập, **Then** thấy thông báo lỗi chung (không tiết lộ email có tồn tại hay không).
3. **Given** một run đã xong, **When** mở chi tiết run, **Then** mỗi step hiện ảnh chụp, trạng thái, locator đã dùng (và đánh dấu `degraded` nếu có), thời gian, popup đã xử lý; step lỗi hiện mã lỗi, thông báo và log thiết bị.
4. **Given** một test case đã lưu, một build và một thiết bị rảnh, **When** bấm chạy trên web, **Then** run được tạo, trạng thái cập nhật trên trang (xếp hàng → đang chạy → kết quả) mà không phải tải lại trang.
5. **Given** người dùng của tenant B, **When** mở đường dẫn tới run của tenant A, **Then** bị từ chối như thể run không tồn tại.

---

### User Story 2 - Xem màn hình thiết bị trực tiếp (Priority: P1)

Người dùng chọn một thiết bị đang online và thấy màn hình của nó cập nhật liên tục trên trình duyệt. Có thể xem cả khi thiết bị đang chạy một run (chỉ xem, không điều khiển). Nhiều người có thể xem cùng một thiết bị.

**Why this priority**: Là nền tảng của điều khiển và Recorder; riêng việc xem run đang chạy đã giúp chẩn đoán lỗi.

**Independent Test**: Mở trang thiết bị của một emulator → hình cập nhật liên tục (≥ 2 khung/giây); mở trên hai trình duyệt cùng lúc → cả hai đều thấy; tạo một run trên thiết bị đó → vẫn xem được run đang chạy.

**Acceptance Scenarios**:

1. **Given** thiết bị online, **When** mở live view, **Then** thấy màn hình trong ≤ 3 giây và hình cập nhật 2–5 khung/giây.
2. **Given** thiết bị đang chạy run, **When** mở live view, **Then** xem được nhưng mọi nút điều khiển bị khóa, kèm lý do "thiết bị đang chạy run".
3. **Given** agent mất kết nối khi đang xem, **When** không còn khung hình mới, **Then** live view báo mất kết nối trong ≤ 5 giây (không đứng hình im lặng) và tự nối lại khi agent quay lại.
4. **Given** mọi người đã đóng live view của thiết bị, **When** hết người xem, **Then** agent ngừng gửi hình của thiết bị đó.

---

### User Story 3 - Điều khiển thiết bị từ trình duyệt (Priority: P1)

Người dùng bấm "Điều khiển" trên một thiết bị rảnh để giữ thiết bị. Khi đang giữ: click trên hình → chạm thật vào đúng vị trí trên thiết bị; kéo → vuốt; gõ chữ → nhập vào ô đang chọn; có nút Back, Home, mở lại app, ẩn bàn phím. Trong lúc giữ, run khác xếp hàng chờ. Người dùng thả thiết bị khi xong; thiết bị tự được thả nếu không thao tác một thời gian.

**Why this priority**: Recorder cần điều khiển; và điều khiển từ xa tự nó đã hữu ích (thử nhanh app trên thiết bị ở xa).

**Independent Test**: Giữ một emulator, click vào một nút trên hình → app phản ứng như chạm tay; trong lúc giữ tạo một run cho thiết bị đó → run chờ; thả thiết bị → run bắt đầu.

**Acceptance Scenarios**:

1. **Given** thiết bị rảnh, **When** bấm "Điều khiển", **Then** người dùng giữ thiết bị; người khác mở cùng thiết bị thấy "đang được điều khiển bởi <tên>" và chỉ xem được.
2. **Given** đang giữ thiết bị, **When** click vào một điểm trên hình, **Then** thiết bị nhận một cú chạm tại đúng điểm tương ứng (sai lệch ≤ 1% kích thước màn hình) và hình mới hiện ra trong ≤ 2 giây.
3. **Given** đang giữ thiết bị, **When** kéo chuột từ A tới B, **Then** thiết bị nhận thao tác vuốt tương ứng.
4. **Given** đang giữ thiết bị, **When** không thao tác quá thời gian chờ, **Then** thiết bị tự được thả và người dùng được báo.
5. **Given** thiết bị đang chạy run, **When** bấm "Điều khiển", **Then** bị từ chối với lý do; run không bị gián đoạn.
6. **Given** đang giữ thiết bị, **When** tạo run cho thiết bị đó, **Then** run xếp hàng và chỉ chạy sau khi thiết bị được thả.

---

### User Story 4 - Ghi test case bằng Recorder (Priority: P1) 🎯 DoD

Người dùng chọn project, app, build và thiết bị rồi bắt đầu ghi. Hệ thống cài build (nếu cần), mở app ở trạng thái sạch và ghi bước khởi động. Mỗi thao tác trên live view (chạm, vuốt, gõ chữ, Back, ẩn bàn phím) vừa được thực hiện trên thiết bị vừa được thêm thành một step: với chạm, hệ thống tìm element tại điểm chạm, trích **toàn bộ** chuỗi locator từ cây element theo thứ tự ưu tiên, cắt ảnh element và lưu snapshot (ảnh màn hình + cây element) của step. Người dùng thêm kiểm tra kỳ vọng bằng cách chọn một element hoặc một đoạn chữ trên màn hình. Khi gõ vào ô mật khẩu, người dùng phải chọn tên secret thay vì lưu giá trị. Cuối cùng người dùng đặt tên, viết `intent`, xem lại YAML và lưu thành test case của project; sau đó chạy lại test case đó từ web.

**Why this priority**: Đây là mục tiêu và DoD của Phase 2: tạo test case không cần viết YAML bằng tay.

**Independent Test**: Ghi một flow 5 step (mở app → chạm menu → chạm "Log In" → gõ tên người dùng → chạm nút đăng nhập, kèm ít nhất một kỳ vọng) trên app mẫu, lưu, chạy lại 3 lần → 3/3 pass.

**Acceptance Scenarios**:

1. **Given** đang ghi, **When** chạm vào một nút có id và chữ, **Then** step mới có chuỗi locator gồm id, chữ, các locator dự phòng khác áp dụng được và ảnh element; locator đầu tiên của chuỗi khớp đúng element đó trên màn hình lúc ghi.
2. **Given** chạm vào vùng không phải element bấm được (ví dụ chữ bên trong một nút), **When** hit-test, **Then** step nhắm vào element bấm được nhỏ nhất chứa điểm chạm.
3. **Given** element không có id, chữ hay mô tả, **When** ghi, **Then** chuỗi locator dùng vị trí tương đối / lớp + thứ tự / ảnh; tọa độ phần trăm chỉ xuất hiện ở cuối và chỉ khi không locator nào khác xác định được element duy nhất.
4. **Given** gõ vào ô mật khẩu, **When** ghi step gõ chữ, **Then** YAML chứa `${secret:TÊN}` do người dùng chọn, không chứa giá trị đã gõ.
5. **Given** một popup hệ thống (ví dụ xin quyền) mà luật popup của project xử lý được, **When** người dùng chạm vào nút của popup, **Then** thao tác được thực hiện nhưng không thành step (vì khi chạy lại guard tự xử lý), và giao diện nói rõ điều đó.
6. **Given** bản ghi đã có các step, **When** lưu, **Then** test case được kiểm tra hợp lệ như Phase 1, lưu vào kho của project thành một commit kèm snapshot từng step; test case lỗi không được lưu và lỗi chỉ rõ step + trường.
7. **Given** test case vừa ghi, **When** chạy lại 3 lần trên cùng thiết bị, **Then** cả 3 lần pass.

---

### User Story 5 - Sửa test case trong editor có ảnh từng step (Priority: P2)

Người dùng mở một test case của project (viết tay, vừa ghi, hoặc cũ) trong editor YAML; bên cạnh mỗi step là ảnh snapshot của step (từ lúc ghi, hoặc từ lần chạy gần nhất). Editor báo lỗi ngay khi YAML sai (đúng dòng, step, trường). Lưu = một commit mới; xem được lịch sử các lần sửa. Nếu người khác đã lưu trước, người dùng được báo xung đột thay vì ghi đè.

**Why this priority**: Recorder hiếm khi cho ra test case hoàn hảo; cần sửa intent, kỳ vọng, thời gian chờ. Nhưng DoD có thể đạt bằng Recorder + màn xem YAML trước khi lưu.

**Independent Test**: Mở test case `mydemo-login`, sửa `timeout_ms` của một step, lưu → lịch sử có commit mới; cố lưu YAML sai → bị chặn với lỗi đúng chỗ; hai tab cùng sửa → tab lưu sau bị báo xung đột.

**Acceptance Scenarios**:

1. **Given** test case có snapshot, **When** mở editor, **Then** mỗi step có ảnh tương ứng; step chưa có ảnh ghi rõ "chưa có ảnh".
2. **Given** YAML sai cú pháp hoặc sai schema, **When** đang gõ, **Then** lỗi hiện kèm vị trí trong ≤ 1 giây sau khi ngừng gõ, nút lưu bị khóa.
3. **Given** hai người mở cùng test case, **When** người thứ hai lưu sau khi người thứ nhất đã lưu, **Then** người thứ hai nhận thông báo xung đột và không mất phần đã sửa.
4. **Given** lưu thành công, **When** mở lịch sử, **Then** thấy commit mới nhất ở đầu với người sửa và thời gian.

---

### User Story 6 - Tìm element bằng ảnh khi các locator khác không còn khớp (Priority: P2)

Khi chạy lại, nếu id, chữ và các locator khác không còn khớp nhưng element vẫn trông như lúc ghi, runner tìm được element nhờ ảnh đã cắt, chạm vào tâm vùng khớp và đánh dấu step `degraded`. Nếu không vùng nào giống đủ, step fail như bình thường thay vì chạm bừa.

**Why this priority**: Tăng độ bền của test ghi bằng Recorder trước khi có Healer (Phase 4); không bắt buộc cho DoD.

**Independent Test**: Trên ảnh màn hình mẫu, một nút đã đổi id/chữ vẫn được tìm thấy bằng ảnh; một màn hình không có nút đó thì không khớp.

**Acceptance Scenarios**:

1. **Given** chuỗi locator của step chỉ còn locator ảnh khớp, **When** chạy, **Then** step pass, `degraded`, locator đã dùng là locator ảnh.
2. **Given** vùng giống nhất có độ tương đồng dưới ngưỡng, **When** chạy, **Then** step fail `TARGET_NOT_FOUND`.
3. **Given** file ảnh mà locator tham chiếu không tồn tại trong kho project, **When** kiểm tra test case, **Then** báo lỗi trước khi chạy.

---

### User Story 7 - Chuẩn bị từ web: app, build và agent (Priority: P3)

Người dùng tạo app, tải build lên và tạo agent token ngay trên web (thay vì gọi API), để một người mới có thể đi từ đầu tới lúc ghi test hoàn toàn bằng trình duyệt.

**Why this priority**: Tiện, nhưng các thao tác này đã làm được qua API/script từ Phase 1.

**Independent Test**: Tạo app, tải một APK, tạo agent token trên web; khởi động agent với token đó → thiết bị hiện trên trang thiết bị.

**Acceptance Scenarios**:

1. **Given** project, **When** tải lên một APK, **Then** build xuất hiện trong danh sách với phiên bản và kích thước.
2. **Given** tạo agent token, **When** token hiện ra, **Then** chỉ hiện đúng một lần, có nút sao chép và cảnh báo lưu lại.

---

### Edge Cases

- Màn hình thiết bị xoay hoặc đổi kích thước giữa lúc điều khiển: quy đổi tọa độ dựa trên kích thước của khung hình mà người dùng đang nhìn; khung cũ không được dùng để quy đổi sau khi kích thước đổi.
- Click ngay lúc màn hình đang chuyển cảnh: Recorder dùng cây element đọc tại thời điểm chạm (sau khi màn hình ổn định), không dùng cây cũ.
- Hai người cùng bấm "Điều khiển" gần như đồng thời: đúng một người giữ được, người kia nhận lý do.
- Agent mất kết nối khi đang giữ hoặc đang ghi: phiên giữ kết thúc, bản ghi chưa lưu vẫn còn trên trình duyệt để lưu khi có kết nối (hoặc bỏ).
- Người dùng đóng tab khi đang giữ thiết bị: thiết bị được thả sau thời gian chờ, không kẹt vĩnh viễn.
- Điểm chạm nằm trong popup mà luật popup không biết: thao tác được thực hiện và ghi thành step bình thường (người dùng chủ động bấm).
- Chạm vào nút nằm trong `never_tap` khi đang ghi: vẫn thực hiện (người chủ động bấm) nhưng Recorder cảnh báo rằng step này là thao tác nguy hiểm.
- Gõ chữ vào ô thường nhưng chữ trùng giá trị một secret đã biết: Recorder đề xuất thay bằng `${secret:TÊN}`.
- Ảnh màn hình trả về chậm hoặc mạng yếu: live view giảm tốc độ khung hình thay vì dồn hàng đợi; luôn hiện khung mới nhất.
- Test case lưu có tham chiếu ảnh nhưng ảnh bị xóa khỏi kho: kiểm tra hợp lệ báo lỗi (US6).
- Phiên đăng nhập hết hạn giữa chừng: web tự làm mới phiên; nếu không làm mới được, đưa về trang đăng nhập mà không mất bản ghi đang dở.

## Requirements *(mandatory)*

### Functional Requirements

**Truy cập web**
- **FR-001**: Người dùng MUST đăng nhập bằng email + mật khẩu của tenant; phiên được duy trì an toàn qua lần mở lại trình duyệt trong thời hạn làm mới; đăng xuất hủy phiên.
- **FR-002**: Mọi trang và mọi luồng dữ liệu (kể cả hình trực tiếp và lệnh điều khiển) MUST chỉ trả dữ liệu thuộc tenant của người dùng; truy cập tài nguyên của tenant khác trả về như không tồn tại (P5).
- **FR-003**: Web MUST hiển thị: danh sách project; trong project: app, build, test case; danh sách thiết bị (trạng thái online/rảnh/bận/offline, model, phiên bản OS, agent); danh sách run (lọc theo project, trạng thái); chi tiết run như US1.
- **FR-004**: Người dùng MUST tạo được run từ web (chọn build, thiết bị, một hay nhiều test case) và thấy trạng thái run cập nhật trực tiếp.

**Live view và điều khiển**
- **FR-005**: Hệ thống MUST truyền hình màn hình của thiết bị được chọn tới mọi người đang xem với 2–5 khung/giây, chỉ trong lúc có người xem; xem không cần giữ thiết bị (D16).
- **FR-006**: Điều khiển MUST cần giữ thiết bị bằng một phiên điều khiển độc quyền (lease loại `live`); tại một thời điểm tối đa một phiên giữ trên mỗi thiết bị, và không đồng thời với run hay exploration.
- **FR-007**: Phiên điều khiển MUST tự kết thúc sau thời gian không thao tác (mặc định 10 phút, cấu hình được), khi người dùng thả, hoặc khi agent mất kết nối; run đang chờ thiết bị được chạy ngay sau đó.
- **FR-008**: Khi giữ thiết bị, người dùng MUST thực hiện được: chạm, chạm giữ, vuốt, gõ chữ, Back, Home, ẩn bàn phím, mở lại / khởi động lại app đang test; vị trí chạm/vuốt được quy đổi từ tọa độ trên hình sang tọa độ thật của thiết bị.
- **FR-009**: Mọi lệnh điều khiển MUST được ghi nhận (ai, thiết bị nào, lệnh gì, khi nào) để tra cứu; lệnh ngoài danh sách FR-008 bị từ chối (P6).

**Recorder**
- **FR-010**: Phiên ghi MUST bắt đầu bằng việc giữ thiết bị, cài build đã chọn (nếu chưa có đúng bản), mở app ở trạng thái sạch và ghi step khởi động; `preconditions` mặc định `app_state: fresh`.
- **FR-011**: Với mỗi chạm, Recorder MUST xác định element đích = element bấm được nhỏ nhất chứa điểm chạm trên cây element đọc sau khi màn hình ổn định (SPEC §11.1), rồi trích **toàn bộ** locator áp dụng được theo thứ tự ưu tiên §7.2 từ cây element (không bao giờ tự đặt locator), cắt ảnh element, lưu snapshot (ảnh màn hình + cây element) của step.
- **FR-012**: Chuỗi locator do Recorder tạo MUST: có ít nhất một locator xác định đúng element lúc ghi; tọa độ phần trăm chỉ ở cuối và chỉ khi không locator nào khác xác định được element duy nhất (P2); locator ảnh được thêm cho mọi step chạm.
- **FR-013**: Recorder MUST ghi được các loại step: `launch`, `tap`, `long_press`, `swipe`, `type`, `back`, `hide_keyboard`, và thêm kỳ vọng (`visible_text`, `visible` theo element, `not_visible`) cho step vừa ghi bằng cách chọn trên màn hình.
- **FR-014**: Gõ chữ vào ô mật khẩu MUST lưu dạng `${secret:TÊN}` do người dùng chọn; giá trị đã gõ không bao giờ được lưu vào test case, snapshot hay log (P5, D19). Chữ trùng giá trị secret đã biết → đề xuất thay bằng tham chiếu secret.
- **FR-015**: Thao tác vào popup mà luật popup của project xử lý được MUST được thực hiện nhưng không thành step; thao tác vào nút thuộc `never_tap` MUST kèm cảnh báo trên step.
- **FR-016**: Bản ghi đang dở MUST không mất khi tải lại trang hoặc mất kết nối ngắn trên cùng trình duyệt; người dùng có thể xóa, sắp xếp lại step và sửa YAML trước khi lưu.
- **FR-017**: Lưu bản ghi MUST: kiểm tra hợp lệ như `coral validate` (Phase 1); nếu hợp lệ, ghi test case + ảnh element + snapshot vào kho git của project thành **một** commit (§13); test case lỗi không được lưu.

**Editor**
- **FR-018**: Editor MUST mở, sửa, kiểm tra và lưu YAML của test case; báo lỗi kèm vị trí trong lúc sửa; mỗi lần lưu là một commit; phát hiện sửa đồng thời (lưu dựa trên phiên bản cũ) và từ chối ghi đè.
- **FR-019**: Editor MUST hiển thị ảnh cho từng step: snapshot lúc ghi nếu có, không thì ảnh step tương ứng của lần chạy gần nhất.
- **FR-020**: Người dùng MUST xem được lịch sử commit của test case (ai, khi nào, thông điệp).

**Locator ảnh**
- **FR-021**: Runner MUST hỗ trợ locator `image` trên máy chạy (không AI, không gọi dịch vụ ngoài): tìm vùng giống ảnh tham chiếu nhất trên ảnh màn hình hiện tại, chấp nhận khi độ tương đồng ≥ ngưỡng (mặc định 0,85, chỉnh được theo locator), chạm vào tâm vùng khớp; dùng locator ảnh thì step `degraded` nếu nó không đứng đầu chuỗi.
- **FR-022**: Ảnh tham chiếu MUST được gửi kèm test case khi giao job cho agent (không cần agent truy cập kho git); `coral validate` và kiểm tra khi lưu MUST báo lỗi nếu ảnh tham chiếu không có trong kho.
- **FR-023**: `coral run` cục bộ MUST dùng được locator `image` với ảnh nằm cạnh file test case.

**Chung**
- **FR-024**: Giao diện web MUST dùng được trên trình duyệt máy tính phổ biến (Chrome, Edge, Firefox bản mới); ngôn ngữ giao diện: [NEEDS CLARIFICATION: tiếng Việt, tiếng Anh, hay cả hai có nút chuyển?].
- **FR-025**: Mọi thông tin mới đi vào hệ thống từ web và agent (lệnh điều khiển, khung hình, bản ghi) MUST được kiểm tra định dạng; khung hình lỗi bị bỏ qua, không làm hỏng phiên.

### Key Entities *(include if feature involves data)*

- **Phiên xem (viewer)**: một người đang xem màn hình một thiết bị; không giữ thiết bị; nhiều phiên xem cùng lúc.
- **Phiên điều khiển (live session)**: thiết bị, người giữ, thời điểm bắt đầu, lần thao tác cuối, lý do kết thúc; đi kèm một lease loại `live` (§6).
- **Lệnh điều khiển**: loại lệnh (chạm, vuốt, gõ…), tham số đã quy đổi, người gửi, thời điểm, kết quả.
- **Bản ghi (recording)**: phiên ghi của một người trên một thiết bị cho một app/build; danh sách step nháp, mỗi step có snapshot và ảnh element; chưa phải test case cho tới khi lưu.
- **Snapshot step**: ảnh màn hình, cây element và ảnh cắt element của một step; lưu cùng test case trong kho git của project (`snap/`, §13).
- **Test case, Run, Step result**: như Phase 1; test case có thêm tham chiếu tới ảnh (locator `image`) và snapshot.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** (DoD): Một người dùng ghi được flow 5 step trên app mẫu hoàn toàn từ trình duyệt, lưu thành test case, và test case đó chạy lại qua server pass **3/3 lần liên tiếp**.
- **SC-002**: Live view hiện màn hình thiết bị trong ≤ 3 giây sau khi mở và cập nhật ≥ 2 khung/giây trên mạng nội bộ; ≥ 90% cú chạm từ web cho ra hình mới phản ánh thao tác trong ≤ 2 giây.
- **SC-003**: Cú chạm từ web rơi vào đúng element người dùng nhắm trong ≥ 98% lần trên bộ màn hình kiểm thử (sai lệch vị trí ≤ 1% kích thước màn hình).
- **SC-004**: 100% step chạm do Recorder tạo có ≥ 2 locator lấy từ cây element, trong đó locator đầu tiên xác định đúng element lúc ghi; 0 step có tọa độ phần trăm ở vị trí khác vị trí cuối.
- **SC-005**: Trên bộ màn hình kiểm thử, locator ảnh tìm đúng element đã đổi id/chữ trong ≥ 95% trường hợp và không khớp nhầm (0 lần) khi element không có trên màn hình.
- **SC-006**: 0 lần hai phiên cùng dùng một thiết bị (điều khiển song song với run, hoặc hai người cùng điều khiển) trong kiểm thử tranh chấp; thiết bị bị bỏ quên được thả trong ≤ thời gian chờ + 1 phút.
- **SC-007**: 0 lần người dùng của tenant này xem được hình, run, test case hay điều khiển được thiết bị của tenant khác trong kiểm thử cô lập.
- **SC-008**: 0 giá trị secret (kể cả mật khẩu gõ khi ghi) xuất hiện trong test case, snapshot, log hay dữ liệu run đã lưu.
- **SC-009**: Trang chi tiết run hiện đủ ảnh của một run 10 step trong ≤ 3 giây; lưu test case từ editor hoặc Recorder mất ≤ 2 giây.

## Assumptions

- Chỉ Android trong Phase 2 (iOS từ Phase 5); dùng lại agent, runner, server, kho git project và giao thức của Phase 1.
- Thiết bị để kiểm DoD là emulator Android 14 trong CI (`.github/workflows/device.yml`) hoặc emulator trên máy Huynh; các kiểm tra khác chạy bằng thiết bị giả lập như Phase 1.
- Phase 2 chưa phân vai (owner/admin/member/viewer) chi tiết: mọi thành viên tenant đều xem và điều khiển thiết bị của tenant; phân quyền đầy đủ ở phase sau.
- Chất lượng hình MVP là ảnh JPEG định kỳ 2–5 khung/giây (SPEC §19); truyền video mượt (scrcpy…) để sau.
- Người dùng dùng máy tính (không tối ưu cho điện thoại/máy tính bảng).
- Ảnh cắt và snapshot lưu trong kho git của project (§13 `snap/`); rủi ro repo phình to đã chấp nhận ở R9.
- Thời gian chờ thả thiết bị mặc định 10 phút; ngưỡng locator ảnh mặc định 0,85 (§7.2).
- Test writer (AI) không tham gia: Recorder không dùng AI (§11.1); `intent` do người dùng viết.
- Chạy lại DoD 3/3 dùng cùng thiết bị và cùng build với lúc ghi.
