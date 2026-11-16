# Checklist tiến độ M1

Trạng thái ngày 17/11/2026, sau GREEN5, review độc lập, kiểm chứng hosted CI và merge PR #1 vào `main`. M1 gồm T03, T07 và T08 theo [roadmap](../../roadmap.md) và kế hoạch gốc `2026-11-13-stability-open-source.md`. Dấu đã chọn ghi phần có bằng chứng, không đồng nghĩa toàn bộ chặng đã nghiệm thu. Các đường dẫn `test-results/` và `.superpowers/` là bằng chứng cục bộ bị Git bỏ qua.

## M0 và các việc còn mở

- [x] Đã khóa các đường ghi production chưa được kiểm chứng; baseline và lượt clone mới chạy lại trên cùng máy được ghi tại [baseline T00](../../quality/baseline.md) và `docs/quality/m0-validation.json`.
- [x] Runner Windows 2025 mới đã provision từ lockfile và chạy đủ suite; artifact và 168 hash nguồn khớp Git blobs. Xem `hostedValidation` trong manifest M1.
- [ ] Hoàn tất T00 trong môi trường Windows ngắt mạng hoàn toàn. CI hiện chứng minh chặn TCP trực tiếp của project và giữ loopback; DNS cùng runner control vẫn được phép. Host cục bộ là Windows Home, chưa có guest Windows dùng được; không thay đổi feature/firewall của máy này.
- [ ] Hoàn tất T01 thuộc M2: xác nhận tác giả, nguồn và quyền phân phối, chọn license với chủ thể có quyền, kiểm dependency và gói thực tế. Danh mục hiện mới là bước mở: [tình trạng quyền](../../legal/status.md), `docs/legal/provenance.csv`. Cổng L chưa đạt.
- [ ] Theo dõi triển khai: Workers Builds kết nối GitHub chưa được kiểm chứng. Lượt M0 đã gặp lỗi OAuth/API và dashboard; M1 không thực hiện deployment.
- [ ] Theo roadmap, đo hiệu suất thuộc T05/T09; kiểm thiết bị thật và soak thuộc T10. Các việc này chưa có bằng chứng nghiệm thu và không được tính là phần đã hoàn tất của M0.
- [ ] Xác minh trình duyệt thực sự đưa trang vào BFCache. Các ca mô phỏng lifecycle và điều hướng quay lại đã chạy, nhưng headless Chromium chưa chứng minh được điều này.

## T03: CI

- [x] Đã tích hợp workflow Windows cho core, browser, hardware offline và job báo cáo dependency; toolchain khai báo Node 24.19.0 và Rust 1.100.0. Xem `.github/workflows/ci.yml`, `rust-toolchain.toml`, `scripts/ci.ps1`.
- [x] Các lượt kiểm cục bộ đã chạy Node, Rust, build, differential, launcher, browser và hardware offline. Ba suite CI wrapper có receipt trong `test-results/m1/ci-smoke/`.
- [x] Git và lệnh version lỗi hoặc trả rỗng bị từ chối trước khi tạo receipt. Regression CI đạt trong GREEN3, GREEN4 và GREEN5; wrapper hardware cuối có 9/9 test và `sourceStable:true` tại `test-results/m1/ci-final/hardware-r5/receipt.json`.
- [x] Hosted CI đạt 4/4 job trên PR #1 và push. Ba ca fixture sai, binary thiếu, browser thiếu đều fail đúng gate với artifact và khôi phục firewall. `main` có bốn required checks, strict và áp dụng cả admin. Xem `hostedValidation`, `hostedRefusalProof` và `branchProtection` trong manifest.
- [x] Hardware offline đạt 9/9 trên PowerShell 7.5.4; policy/probe hosted chứng minh TCP trước/sau hoạt động, TCP trực tiếp bị chặn trong gate, loopback hoạt động và firewall được phục hồi.

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
- [x] Đã review và merge [PR #1](https://github.com/nhan-zunika01/peripheral-workbench/pull/1) vào `main` tại `52cd1a063334d08180f8b555fbb62c23f081771f`. [CI trên main](https://github.com/nhan-zunika01/peripheral-workbench/actions/runs/43913838429) đạt 4/4 job. T00 cách ly hoàn toàn, cổng L, phần cứng, soak và hiệu suất vẫn còn mở. Source/alpha cần L+C; stable release cần cổng R.

## Kiểm chứng hosted

- [x] Hosted đạt 125 Node, 154 Rust, 134 contract, 4 launcher, 15 macro browser, 13 QA, 21 UI và 9 hardware offline; source và log hashes được kiểm lại từ artifact.
- [x] Đã sửa lỗi context YAML cấp job, scanner cũ không đọc CVSS 4, và rule IPv6 loopback không được Windows chấp nhận. cargo-deny 0.20.2 đã pin checksum; npm báo 0 vulnerability, Rust không có lỗi advisory/license/source, chỉ cảnh báo ISC allowance không dùng.
- [x] Nhánh kiểm thử `codex/m1-ci-negative-proof` tạo ba lỗi chủ đích để chứng minh CI từ chối. Đây là acceptance proof, không tính vào năm vòng regression thật.
- [ ] Website chưa được triển khai từ M1; trạng thái merge không thay đổi bản website đang chạy.
