# Tình trạng hồ sơ quyền

Cổng L chưa đạt. Danh mục [provenance.csv](provenance.csv) là bước mở T01 trên cây làm việc ngày 15/11/2026, chưa phải danh mục đầy đủ cho một artifact phát hành. Các dòng có thể chồng phạm vi để giữ riêng những phần cần xem xét. `Unknown` và các quyết định đang chờ không xác nhận quyền sở hữu hay cấp phép.

Người dùng đã cho phép công bố source hiện có và triển khai. Quyền đó không chọn license dự án hay xác nhận tác giả và quyền của từng thành phần. README ghi chưa chọn license; chưa có quyết định của chủ thể có quyền về phạm vi và license. Cần xác nhận quyền đối với mã, SVG, tài liệu và fixture trước khi hoàn tất T01.

Cấu hình `wrangler.jsonc` chỉ định `public/` làm assets và `src/worker.mjs` làm Worker. `public/index.html` tải GSAP và Flip. [Notice hiện có](../../public/vendor/gsap/NOTICE.txt) ghi phiên bản 3.15.0 và dẫn tới [điều khoản GSAP](https://gsap.com/standard-license/). Cần kiểm điều khoản áp dụng cho đúng bản và cách phân phối; notice hiện có chưa chứng minh mọi nghĩa vụ đã được xử lý.

`package-lock.json` ghi chuỗi Wrangler, Miniflare, sharp và các gói `@img` theo nền tảng. Những mục này thuộc dependency phát triển trong lockfile. Metadata của sharp và các gói native có license khác nhau; [hướng dẫn cài đặt sharp](https://sharp.pixelplumbing.com/install/) mô tả các gói native và tùy chọn cài đặt. Chưa kiểm artifact thực tế để xác định gói nào được phân phối. Không suy nghĩa vụ của một gói phát hành chỉ từ nhóm `devDependencies`.

Rust có hai đường build được hướng dẫn trong `docs/setup.md`: helper và standalone companion. `bridge/rust/Cargo.toml` chọn `hidapi` với `windows-native`; `bridge/rust/Cargo.lock` liệt kê crates, nhưng chưa xác minh dependency theo target và các thư viện liên kết trong từng binary. Các `include_str!` tìm thấy trong `bridge/rust/tests/` đưa fixture vào test binary. Chưa tìm thấy file C# được theo dõi hay mã C# nhúng qua tìm kiếm trong `bridge/`, `scripts/` và `tests/`; chưa kiểm binary để kết luận về nội dung của chúng.

`bridge/protocol.cjs` dẫn tới hồ sơ nguồn Synapse và `docs/setup.md` mô tả setter và payload middleware được dựng từ source đã kiểm tra. Cần người đủ chuyên môn đối chiếu hồ sơ thu nhận nguồn, phiên bản EULA áp dụng và quyền liên quan cho từng phần. Giữ nội dung proprietary và capture riêng tư ngoài hồ sơ công khai. `tests/fixtures/rust-read-only-parity.json` ghi một lần so sánh đọc thiết bị thật; fixture này không phải dữ liệu giả lập.

`reference.svg` được `source.json` trỏ về một bản thiết kế cục bộ, nhưng chưa ghi creator hoặc license. Repo chưa theo dõi font file; stylesheet dùng tên font hệ thống. Các đường dẫn ảnh sản phẩm trong catalog hiện là null. Cần rà lại provenance và điều khoản khi thêm ảnh hoặc font.

T01 còn cần quyết định license của chủ thể có quyền, rà toàn bộ file và dependency thực sự phân phối, bổ sung license text và notice phù hợp, sau đó kiểm gói và chạy REUSE theo kế hoạch. Chưa có SBOM, kết quả quét license, biên bản ký phạm vi hay kết quả kiểm gói trong hồ sơ này.
