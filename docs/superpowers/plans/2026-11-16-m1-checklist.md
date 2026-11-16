# Checklist tiến độ M1

Trạng thái ngày 16/11/2026, sau GREEN5 và review độc lập. M1 gồm T03, T07 và T08 theo [roadmap](../../roadmap.md) và kế hoạch gốc `2026-11-13-stability-open-source.md`. Dấu đã chọn ghi phần có bằng chứng, không đồng nghĩa toàn bộ chặng đã nghiệm thu. Các đường dẫn `test-results/` và `.superpowers/` là bằng chứng cục bộ bị Git bỏ qua.

## M0 và các việc còn mở

- [x] Đã khóa các đường ghi production chưa được kiểm chứng; baseline và lượt clone mới chạy lại trên cùng máy được ghi tại [baseline T00](../../quality/baseline.md) và `docs/quality/m0-validation.json`.
- [ ] Dựng Windows VM sạch, provision từ lockfile rồi cách ly mạng ở cấp hệ điều hành và chạy lại suite. Bằng chứng trên cùng máy và cache hiện có chưa hoàn tất nghiệm thu T00 hoặc cổng C.
- [ ] Hoàn tất T01 thuộc M2: xác nhận tác giả, nguồn và quyền phân phối, chọn license với chủ thể có quyền, kiểm dependency và gói thực tế. Danh mục hiện mới là bước mở: [tình trạng quyền](../../legal/status.md), `docs/legal/provenance.csv`. Cổng L chưa đạt.
- [ ] Theo dõi triển khai: cấu hình Workers Builds kết nối GitHub khi có đủ quyền. OAuth/API hiện bị từ chối và phiên dashboard chưa được xác minh; deployment trực tiếp trước đó không chứng minh tích hợp GitHub hoạt động. Xem `docs/quality/baseline.md` và `.superpowers/sdd/2026-11-13-stability-open-source/progress.md`.
- [ ] Theo roadmap, đo hiệu suất thuộc T05/T09; kiểm thiết bị thật và soak thuộc T10. Các việc này chưa có bằng chứng nghiệm thu và không được tính là phần đã hoàn tất của M0.

## T03: CI

- [x] Đã tích hợp workflow Windows cho core, browser, hardware offline và job báo cáo dependency; toolchain khai báo Node 24.19.0 và Rust 1.100.0. Xem `.github/workflows/ci.yml`, `rust-toolchain.toml`, `scripts/ci.ps1`.
- [x] Các lượt kiểm cục bộ đã chạy Node, Rust, build, differential, launcher, browser và hardware offline. Ba suite CI wrapper có receipt trong `test-results/m1/ci-smoke/`.
- [x] Git và lệnh version lỗi hoặc trả rỗng bị từ chối trước khi tạo receipt. Regression CI đạt trong GREEN3, GREEN4 và GREEN5; wrapper hardware cuối có 9/9 test và `sourceStable:true` tại `test-results/m1/ci-final/hardware-r5/receipt.json`.
- [ ] Chạy workflow trên GitHub Actions và kiểm từng job, artifact cùng việc fixture sai hoặc binary/browser thiếu làm job thất bại. Xác minh required checks trong cấu hình bảo vệ nhánh; YAML tự nó không chứng minh các kiểm tra đã được bật hay đã đạt.
- [ ] Xác minh bước hardware trên hosted runner dùng PowerShell 7.5.4 và lớp chặn mạng thực sự hoạt động. Các receipt hiện có dùng PowerShell 7.6.9 cục bộ, chưa xác minh workflow trực tiếp.

## T07: một writer macro

- [x] Đã tích hợp Web Locks với một writer, tab theo sau chỉ đọc, tải lại trước khi nhận quyền ghi, và chế độ chỉ trong bộ nhớ khi không có lock. Mã ở `public/macros.js`, `public/app.js`; kiểm thử ở `tests/frontend-project.test.mjs` và `scripts/verify-macro-storage.mjs`.
- [x] RED1 tái hiện deadlock khi lỗi quota gặp draft chưa hợp lệ qua `pagehide/pageshow`. Bản sửa giữ draft có thể sửa hoặc xuất trong bộ nhớ; GREEN1 chạy đủ suite sau sửa. Xem `test-results/m1/round1/` và `test-results/m1/GREEN1/receipt.json`.
- [x] RED2 tái hiện lỗi nhập JSON hoặc file quá giới hạn bị che bởi cảnh báo memory-only. Bản sửa giữ cả thông báo thao tác và trạng thái lưu; GREEN2 chạy đủ suite sau sửa. Xem `test-results/m1/round2/` và `test-results/m1/GREEN2/receipt.json`.
- [x] RED3 tải backup thất bại đã được sửa: export chỉ serialize, draft giữ bảo vệ đến khi người dùng xác nhận thay thế và có lock cùng dữ liệu đọc hợp lệ. GREEN3 và các lượt sau giữ test lỗi download, hủy/xác nhận và đọc lỗi.
- [x] RED3 mất focus đã được sửa: giữ focus/caret tìm kiếm, cập nhật trạng thái Profiles tại chỗ và không thay điều khiển settings. Xem `test-results/m1/round3/` và browser suite trong GREEN3–GREEN5.
- [x] R4 giữ tên/độ trễ hợp lệ ngay khi gõ, retry đọc lại storage đã phục hồi và chặn Save/Export khi còn trường hiển thị không hợp lệ. R5 sửa nhãn đọc màn hình dùng độ trễ cũ. Các test đỏ trước sửa ở `test-results/m1/round4/`, `test-results/m1/round5/`; GREEN4/GREEN5 và review riêng đều đạt.

## T08: backup macro

- [x] Parser và picker dùng chung trần 32.000.000 byte; kiểm thử biên nhận đúng 32.000.000 byte và từ chối 32.000.001 byte. Xem `public/macros.js`, `public/macro-view.js`, `tests/qa-local-drafts.test.mjs` và `test-results/m1/GREEN2/macro-storage.stdout`.
- [x] Bộ dữ liệu 100 macro × 500 key event với Unicode cần escape xuất và nhập lại dưới trần; kiểm thử xác nhận nội dung và ID mới. Browser QA cũng chạy qua picker, kể cả khi quota lưu thất bại. Xem `tests/qa-local-drafts.test.mjs` và `test-results/m1/GREEN2/macro-storage.stdout`.
- [x] Đã kiểm việc giữ draft khi tải backup lỗi, cùng đầy đủ ca round-trip, quota và giới hạn picker/parser trong GREEN5.
- [ ] Đo thời gian parse/export/save ở biên theo T05 khi đến chặng hiệu suất; chưa coi kết quả chức năng là benchmark.

## Các vòng kiểm và bàn giao

- [x] GREEN0–GREEN5 đều có 14/14 phase PASS, `sourceStable` và `snapshotStable` đều true. Node lần lượt 117/118/118/121/123/123; Rust 154 và hardware offline 9 mỗi lượt; macro browser 8/9/10/12/15/15. GREEN3 dùng receipt `test-results/m1/GREEN3-retry/receipt.json`; các lượt khác dùng thư mục cùng tên.
- [x] Đã hoàn tất năm vòng tìm lỗi thật, viết regression đỏ trước sửa và chạy lại toàn bộ suite sau mỗi vòng; mọi test phát sinh được giữ trong suite. Lỗi thiết lập Git của snapshot ở lượt GREEN3 đầu được giữ log; full retry dùng cùng hash nguồn, không bỏ gate.
- [x] Review độc lập về đặc tả và tiêu chuẩn đã đóng các phát hiện sau kiểm lại. Receipt review: `test-results/m1/review-final.json`. Bằng chứng công khai, source hash và giới hạn: [manifest M1](../../quality/m1-validation.json).
- [ ] Nghiệm thu M1 khi T03, T07, T08 và các bằng chứng còn thiếu đạt. Tình trạng CI hosted, cổng L/C và các hạng mục phần cứng vẫn phải được xác minh riêng.
