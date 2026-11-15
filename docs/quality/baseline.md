# Baseline kiểm chứng T00

Ngày chạy: 15/11/2026 (Asia/Saigon). Đây là kết quả trên Windows cục bộ, dùng checkout và cache hiện có. Chưa có Windows VM sạch, fresh clone hoặc cách ly mạng ở cấp hệ điều hành; vì vậy chưa thông qua cổng C của roadmap.

Manifest công khai: [m0-evidence.json](m0-evidence.json). File này chứa hash nguồn, lockfile, binary và log; không chứa token, serial, USB path hoặc đường dẫn hồ sơ người dùng. Log và ảnh raw nằm trong scratch bị Git bỏ qua, không phải tài liệu phân phối.

## Nguồn đã kiểm

HEAD ban đầu là `3d0679cae96ce3dd561f0d2fa65ce55a5104c63a`. Đối chiếu đủ 140 file trong manifest rà soát ngày 13/11: 138 hash khớp; `.gitignore` và `README.md` khác do thay đổi tài liệu đang tiếp diễn. Hash `docs/setup.md` và ba file hardware gate đã có trong manifest rà soát. Ba file gate vẫn là candidate chưa commit tại thời điểm chụp, không được coi là baseline phát hành chính thức.

Các thay đổi runtime diễn ra trong lúc kiểm. Để tách kết quả gốc, phần Rust được dựng lại trong scratch từ `git archive HEAD`; các file khác biệt xuống dòng được phục hồi chỉ khi hash khớp manifest gốc. Cả 57 file Rust khớp từng byte trước khi nghiệm thu. Cargo test, fmt, clippy, release build, differential và launcher bên dưới dùng bản nguồn gốc đó. Một lần Cargo test trên checkout đang thay đổi gặp assertion của test write gate mới; log lỗi được giữ riêng và không quy cho baseline gốc.

Node test chạy trước thay đổi runtime. QA lưu hash của 11 file giao diện và cả 11 khớp manifest ban đầu. Các lượt kiểm tích hợp sau sửa phải dùng manifest riêng; không kế thừa kết quả gốc chỉ vì HEAD chưa đổi.

## Môi trường

| Thành phần | Phiên bản / trạng thái |
| --- | --- |
| Windows | Windows NT 10.0.26200.0, x86_64 |
| Node / npm | 24.19.0 / 11.17.0 |
| Rust / Cargo | 1.100.0; host `x86_64-pc-windows-msvc`; LLVM 23.1.5 |
| PowerShell | 7.6.9 |
| Playwright / Chromium | 1.64.1 / 156.0.8078.4 |
| Wrangler / GSAP | 4.156.0 / 3.15.0, theo package lock |

Shim `rustc.exe` và `cargo.exe` trên PATH mặc định có kích thước 0 byte nên không chạy được. Các lệnh đạt dùng binary trong toolchain stable công khai đã cài, đặt thư mục `bin` lên đầu PATH. Cache Cargo mặc định thiếu `hidapi`; thử provision bằng `cargo fetch --locked` thất bại do không phân giải được `index.crates.io`. Lượt offline đạt dùng cache Cargo đã có của workspace. Đây là giới hạn môi trường, chưa chứng minh người khác provision được từ đầu.

`npm ci` đạt, thêm 37 package, audit 38 package và báo 0 vulnerability tại thời điểm chạy. npm cũng báo install script của esbuild/workerd chưa được allow-list; dry-run build vẫn đạt. Kết quả audit này không thay thế kiểm quyền hoặc rà dependency chuyên biệt.

## Kết quả nguồn gốc

`<baseline-source>` trỏ tới thư mục scratch có 57 hash Rust khớp manifest gốc. Tất cả lệnh Cargo kiểm/build dùng `--offline --locked`, trừ formatter không có hai tham số này.

| Lệnh | Exit | Kết quả |
| --- | --- | --- |
| `npm test` | 0 | 96 pass, 0 fail, 0 skip |
| `cargo test --offline --locked --manifest-path <baseline-source>/bridge/rust/Cargo.toml` | 0 | 150 pass, 0 fail, 0 ignored |
| `cargo fmt --manifest-path <baseline-source>/bridge/rust/Cargo.toml -- --check` | 0 | Không có diff format |
| `cargo clippy --offline --locked --manifest-path <baseline-source>/bridge/rust/Cargo.toml --all-targets -- -D warnings` | 0 | Không có warning bị bỏ qua |
| `cargo build --offline --locked --release --manifest-path <baseline-source>/bridge/rust/Cargo.toml --bins` | 0 | Build cả ba binary; không tạo gói phân phối |
| `node <baseline-source>/scripts/verify-companion-contract.mjs --candidate-test-server <baseline-contract-executable>` | 0 | 134 ca hợp đồng frozen |
| `node <baseline-source>/scripts/verify-companion-launcher.mjs --candidate-test-server <baseline-contract-executable>` | 0 | Hai caller × hai write mode; fake HTTP thật, quyền sở hữu child giả lập |
| `npm run build` | 0 | Wrangler dry-run; không deploy |
| `node scripts/verify-project-qa.mjs` với output mới | 0 | 13 check, 24 ảnh, 0 page error; companion được mock |
| `node --test tests/companion-hardware-check.mjs` | 0 | 9 pass, 0 fail, 0 skip |

`test:ui` chưa chạy trên snapshot gốc. Nó thuộc lượt kiểm tích hợp candidate với server tĩnh do harness sở hữu; không được gán ngược thành kết quả baseline gốc.

## Review ba file hardware gate

Đã đọc `scripts/verify-companion-hardware.ps1`, `tests/companion-hardware-check.mjs` và `tests/support/hardware-gates-check.ps1` trước thực thi. CLI không có operation bị từ chối trước kết nối. Test HTTP dùng server loopback cổng ngẫu nhiên; workflow dùng transport/listener giả và journal trong thư mục tạm. Không chạy CLI ReadOnly/apply/restore trên companion thật.

Chín test kiểm binding tham số, source/build pin, single POST sau timeout, crash intent, observation cũ, lease độc quyền, giữ nguyên chuỗi JSON dạng ngày và không tự retry/restore. Những assertion PowerShell bổ sung nằm trong các scenario được Node gọi. Chúng chứng minh hành vi fake workflow; chưa xác minh G1/G2, model, firmware, getter hoặc khôi phục trên thiết bị thật.

## Chạy lại candidate

[Manifest M0](m0-validation.json) lưu bốn lượt tích hợp đạt: GREEN0 trước vòng phản biện, rồi GREEN1, GREEN2 và GREEN3 sau từng lỗi được sửa. Mỗi lượt có 12 phase đạt và nguồn trước/sau không đổi. Ba log RED được giữ bằng hash. GREEN3 đạt 111 test Node, 154 test Rust, 9 test offline, 134 ca differential, 4 tổ hợp launcher, 13 check project QA và 21 check UI; không có fail hoặc skip.

Regression trình duyệt production dùng transport hiện tại với companion cũ giả lập và xác nhận không có POST setter. Các suite kiểm tương tác ghi/recovery dùng transport lịch sử được đóng băng trong `tests/fixtures/legacy-source/public/transport.js`; receipt ghi rõ `historical-mock` và hash của cả transport được phục vụ lẫn production. Kết quả đó không cấp quyền ghi cho production.

Harness cục bộ nằm trong scratch `.superpowers/sdd/2026-11-13-stability-open-source/validate.ps1`; nhận `-Output` là thư mục mới và có thể nhận `-RustBin`, `-CargoCache` để dùng toolchain/cache khác. Nó lưu nguồn trước/sau, từng exit code, số test và hash log; source thay đổi giữa lượt làm receipt thất bại. Harness kiểm Node, Cargo, fmt/clippy, release, differential, launcher, build, project QA, `test:ui` và hardware offline. UI dùng server tĩnh loopback do lượt chạy tạo và dừng, cùng mock companion của test.

Người chạy lại cần provision lockfile, toolchain và browser trước khi cách ly môi trường. Chưa có bằng chứng fresh clone độc lập; chưa chạy hardware thật, soak, benchmark hoặc kiểm package/license trong T00.
