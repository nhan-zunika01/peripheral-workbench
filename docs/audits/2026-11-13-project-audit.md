# Rà soát Peripheral Workbench ngày 13/11/2026

Peripheral Workbench là giao diện trình duyệt điều khiển thiết bị Razer qua companion Windows chạy trên máy người dùng. Worker phục vụ giao diện; truy cập HID và thao tác ghi diễn ra cục bộ. Phạm vi tải dùng để đánh giá: một người dùng, 1–4 thiết bị, 1–5 tab; nhiều client hơn được dùng để kiểm tra quá tải, không phải định hướng xây dịch vụ nhiều người dùng.

Dự án có nền tảng bảo vệ thao tác thiết bị đáng giữ, nhưng chưa đủ bằng chứng để phát hành bản ổn định cho người dùng phổ thông. Phần mã của dự án cũng chưa được cấp giấy phép mã nguồn mở. Hai việc này có tiêu chí riêng: chất lượng kỹ thuật không phải điều kiện OSI xét cấp giấy phép cho từng dự án.

## Phạm vi và mức chắc chắn

- Commit gốc: `3d0679c`; [source manifest](2026-11-13-source-manifest.json) ghi commit đầy đủ và SHA256 từng file, không chứa nội dung file. Bản sửa chưa commit của `docs/setup.md` chỉ được ghi hash, nên manifest không đủ để dựng lại nguyên văn tài liệu tại thời điểm rà soát.
- Có 137 file được Git theo dõi tại thời điểm bắt đầu. Đã đọc thêm ba file kiểm thử phần cứng chưa được theo dõi và bản sửa sẵn có của `docs/setup.md`.
- Giữ nguyên thay đổi sẵn có: `docs/setup.md`, `scripts/verify-companion-hardware.ps1`, `tests/companion-hardware-check.mjs`, `tests/support/hardware-gates-check.ps1`, cùng `graphify-out/`.
- Đã truy vấn graphify để tìm các luồng phối hợp; graph tạo ngày 11/11 và phiên bản CLI khác phiên bản skill. Mọi phát hiện bên dưới được đối chiếu lại mã nguồn hiện tại; graph không phải bằng chứng kiểm thử.
- Đã kiểm tra entrypoint, manifest, launcher, luồng HTTP → backend → HID, điều phối Rust, lưu macro, giới hạn nhập/xuất, tập kiểm thử liên quan và tài liệu giấy phép chính thức.
- Chưa chạy `npm test`, Cargo tests, build, browser QA, benchmark, quét advisory hoặc thử thiết bị thật. Không có kết luận PASS cho những mục này trong báo cáo.
- Rà soát bảo mật ở mức tĩnh, không phải pentest hoàn chỉnh. Quy trình security-audit yêu cầu sandbox có giới hạn tài nguyên, mạng và vùng ghi; môi trường phiên này chưa được xác nhận đáp ứng các điều kiện đó.
- Chưa rà từng dòng của toàn bộ giao thức, mã Win32 `unsafe`, mọi nhánh recovery, toàn bộ lịch sử nguồn gốc hoặc nội dung tất cả dependency. Không kết luận dự án không còn lỗi hay lỗ hổng.

Các tham chiếu `path:line` chỉ trạng thái tại source manifest. Tên file dự kiến trong kế hoạch chưa phải tính năng đã tồn tại. P0 nghĩa là chặn loại phát hành liên quan, P1 là việc cần giải quyết trước bản ổn định, P2 là việc cải thiện sau khi rủi ro chính đã được kiểm soát. Đây là mức ưu tiên dự án, không phải điểm mức độ nghiêm trọng của lỗ hổng bảo mật.

## Những gì đã có

| Năng lực | Bằng chứng trong nguồn | Giới hạn của bằng chứng |
| --- | --- | --- |
| Ghép cặp theo exact origin, Host và token | `bridge/server.mjs:47`, `bridge/rust/src/http.rs` | Không bảo vệ khỏi mọi chương trình độc hại đã chạy dưới tài khoản cục bộ |
| Không tự chuyển thao tác sang thiết bị khác | `bridge/backend.mjs:37`, `bridge/rust/src/physical_backend.rs:95`, `attachment.rs` | Vẫn cần thử rút/cắm và hai thiết bị cùng model trên máy thật |
| Kiểm tra giá trị trước ghi | `expectedValue` trong server và `backend::transact` | Đây là so sánh phía phần mềm, không phải giao dịch nguyên tử trong firmware |
| Không tự phát lại ghi sau lỗi mạng | `public/transport.js`, `tests/browser.test.mjs` | HTTP 401 chỉ được thử lại sau ghép cặp vì xác thực xảy ra trước dispatch |
| Rust cô lập worker và giữ trạng thái ghi chưa rõ kết quả | `worker.rs`, `session_guard.rs`, `physical_backend.rs:206` | Chưa chứng minh bằng thử nghiệm thiết bị thật trong lần rà soát này |
| Phân biệt đọc xác nhận với ACK | `bridge/native-host.cjs:106`, `public/app.js` | Smart tracking không có getter độc lập; ACK không chứng minh toàn bộ trạng thái |
| Bộ kiểm thử giả lập khá rộng | `tests/`, `bridge/rust/tests/`, các fixture parity | Sự tồn tại của test không đồng nghĩa test đang đạt |
| Bảo vệ bản macro hỏng/không đọc được | `public/macros.js:25`, `tests/frontend-project.test.mjs` | Chưa giải quyết ghi cạnh tranh giữa các tab |
| Không đóng gói ảnh sản phẩm chưa có quyền | `public/assets/models/README.md`, `source.json` | Sơ đồ SVG đang phát hành vẫn cần khai báo tác giả và giấy phép |

## Việc phải giải quyết trước loại phát hành tương ứng

### A01. Chưa có giấy phép dự án và hồ sơ quyền phân phối

Ưu tiên P0 cho công bố mã nguồn mở. Bằng chứng: `README.md:39` của snapshot gốc nói chưa chọn giấy phép; root không có `LICENSE`; `package.json` và `bridge/rust/Cargo.toml` không khai báo license.

Người nhận chưa có một giấy phép dự án nêu rõ quyền dùng, sửa và phân phối lại. Phần giao thức và session adapter có mô tả được dựng từ nguồn Synapse đã kiểm tra (`bridge/protocol.cjs:1`, `docs/setup.md:175`), nhưng hồ sơ nguồn gốc được nhắc tới nằm ngoài tập file công khai. Điều đó chưa đủ để kết luận vi phạm, cũng chưa đủ để khẳng định quyền tái cấp phép cho mọi dòng mã.

Sửa tối thiểu: lập danh mục tác giả/nguồn/quyền của mã, SVG, fixture và dependency; chủ thể có quyền chọn license; đưa văn bản license và phạm vi áp dụng vào repo. Kiểm tra riêng mã lấy nguyên văn, mã chuyển thể và phần tự viết theo hành vi quan sát được. Nếu bỏ qua, người dùng và cộng tác viên khó xác định quyền của họ. Thực hiện T01.

### A02. GSAP là thành phần có điều kiện sử dụng riêng

Ưu tiên P0 nếu mục tiêu là gói phát hành có toàn bộ thành phần mã nguồn mở. `package.json` dùng GSAP 3.15.0; `public/vendor/gsap/` chứa GSAP và Flip; `scripts/sync-vendor.mjs` chép chúng vào tài nguyên phát hành.

Giấy phép GSAP đang công bố hạn chế một số công cụ tạo animation trực quan cạnh tranh với Webflow. Hạn chế mục đích sử dụng này không phù hợp tiêu chí tự do sử dụng theo lĩnh vực của OSD. Có thể cấp phép mã tự viết riêng, nhưng không được đổi nhãn GSAP thành Apache/MIT hoặc tuyên bố mọi byte trong gói cùng một giấy phép. [Điều khoản GSAP](https://gsap.com/community/standard-license/), [OSD mục 6](https://opensource.org/osd).

Phương án ưu tiên cho mục tiêu của dự án: thay các hiệu ứng nhỏ trong `public/motion.js` bằng CSS/Web Animations API, giữ reduced motion và trạng thái focus, rồi bỏ dependency/vendor cùng bước sync. Nếu giữ GSAP, phải mô tả gói có giấy phép hỗn hợp và xác minh điều kiện phân phối bản chính xác. NOTICE hiện tại là thông tin tham chiếu, không phải bằng chứng mọi nghĩa vụ đã hoàn tất. Thực hiện T02.

### A03. Đường chạy mặc định vẫn cho ghi dù chưa có bằng chứng phần cứng

Ưu tiên P0 cho bản phát hành ổn định có khả năng ghi. `scripts/bridge.mjs:7` chọn legacy; `bridge/backend.mjs:10` chọn native; `native-host.cjs:37` đánh dấu writable khi có setter. README và fixture parity xác nhận chưa thử ghi trên thiết bị thật. Cờ `RAZER_COMPANION_WRITES` chỉ điều khiển standalone Rust, không khóa ghi legacy native.

Ca cần xử lý: helper gặp timeout sau khi thiết bị có thể đã nhận lệnh. UI giữ trạng thái uncertain trong bộ nhớ (`public/app.js:319`, `public/review.js:4`), nhưng tải lại trang làm mất ledger đó. Legacy server không có session journal tương đương standalone Rust. Người dùng có thể mở phiên mới và gửi thao tác khác khi tác động phụ của lần trước chưa được xác minh.

Sửa tối thiểu cho giai đoạn chuyển tiếp: mặc định chỉ đọc trên mọi đường sản phẩm; chỉ mở setter theo model/firmware đã có bằng chứng và lựa chọn rõ ràng. Dùng recovery có sẵn của Rust làm nền cho đường ghi được hỗ trợ lâu dài. Không tạo một hệ phục hồi đầy đủ thứ hai trong legacy nếu legacy sắp rút khỏi vai trò chính. Nếu bỏ qua, cảnh báo trong README không ngăn được thao tác thật. Thực hiện T04, T10, T13.

## Việc cần hoàn tất trước bản ổn định

### A04. Hai tab có thể làm mất thay đổi macro của nhau

Ưu tiên P1, lỗi suy ra trực tiếp từ mã nguồn, chưa tái hiện runtime. `public/macros.js:25` đọc localStorage một lần; `save():43` ghi lại toàn bộ thư viện. `public/app.js:12` tạo một instance cho từng trang; không có phối hợp `storage`/khóa ghi.

Ca cụ thể: A và B cùng mở thư viện rỗng; A tạo macro thứ nhất; B tạo macro thứ hai từ bản rỗng cũ. Lần lưu của B thay toàn bộ giá trị, làm mất macro A trên đĩa dù A từng báo lưu thành công.

Sửa: một tab giữ quyền sửa thư viện theo origin bằng Web Locks; các tab khác chỉ đọc và tải lại khi chủ ghi thay đổi dữ liệu. Nếu trình duyệt không hỗ trợ cơ chế phối hợp, giữ chỉnh sửa trong bộ nhớ và yêu cầu export thay vì âm thầm ghi cạnh tranh. Không chỉ thêm version rồi check/set localStorage vì hai bước đó không nguyên tử. Thực hiện T07.

### A05. Bản backup hợp lệ có thể không nhập lại được

Ưu tiên P1, lỗi giới hạn định dạng suy ra từ mã. `public/macros.js:1` cho 100 macro × 500 event nhưng `parseMacroImport:14` chặn hơn 1.000.000 byte. `export():64` xuất toàn bộ thư viện có thụt lề mà không bảo đảm giới hạn đó. `public/macro-view.js:23` còn kiểm kích thước độc lập.

Ca cụ thể: 100 macro, mỗi macro có 500 key event hợp lệ. Chỉ riêng tên trường và giá trị event đã vượt 1 MB. UI vẫn cho lưu/xuất, nhưng file export bị bộ nhập từ chối. Các test round-trip hiện đọc chỉ dùng thư viện nhỏ.

Sửa: thống nhất giới hạn byte theo dung lượng tối đa hợp lệ, dùng cùng hằng số cho picker và parser; thử đủ kích thước tối đa, Unicode và giá trị biên. Giữ giới hạn hữu hạn và kiểm trước parse. Không chữa bằng cách xóa dữ liệu hoặc thu nhỏ thư viện cũ. Thực hiện T08.

### A06. Hàng đợi đọc và số kết nối chưa có trần rõ ràng

Ưu tiên P1 cho khả năng chịu quá tải cục bộ. `coordinator.rs:64` dùng channel không giới hạn; `read():117` nhận thêm mỗi ID khác nhau vào map và tăng `active`. HTTP chỉ kiểm hình dạng ID. `http_server.rs:150` tạo task cho mỗi socket; legacy dùng `reads` map và chờ `activeWork` trong `bridge/server.mjs:62`.

Ca cụ thể: client đã ghép cặp gửi nhiều ID khác nhau trong lúc HID chậm. Các yêu cầu xếp hàng, vẫn phải được xử lý sau khi người chờ timeout; ghi bị từ chối khi còn `active`. `transactions.rs` đã kiểm tra giữ quyền sở hữu worker sau timeout, nhưng không đặt giới hạn hàng đợi. Đây là điểm yếu chịu tải, chưa phải kết luận có tấn công từ website ngoài origin.

Sửa: trần số đọc khác ID và kết nối, từ chối sớm khi đầy; chỉ bỏ đọc chưa bắt đầu mà không còn người chờ hoặc đã hết hạn. Giữ nguyên quy tắc không hủy/phát lại ghi chưa rõ kết quả và không nhả quyền worker đang hoạt động. Thực hiện T06.

### A07. Đường mặc định phụ thuộc một bản Synapse cụ thể

Ưu tiên P1 cho độ bền triển khai. `bridge/backend.mjs:8`, `native-host.cjs:139` gắn với `app-4.0.896`. Khi người dùng cập nhật/gỡ bản đó, `existsSync(engine)` thất bại; bản clone không tự có runtime tương thích.

Đây là giới hạn đã được ghi chú trong nguồn, không phải lỗi mới bị che giấu. Nhưng nó chưa đáp ứng mục tiêu vận hành dài hạn và độc lập nhà cung cấp. Standalone Rust đã có, nên kế hoạch là hoàn tất kiểm chứng và chuyển đổi có điều kiện, không viết backend mới. Không dò tự động addon của mọi bản Synapse khi chưa kiểm chứng ABI/giao thức. Thực hiện T10, T13.

### A08. Chưa có CI tái lập được các kiểm tra hiện có

Ưu tiên P1. Snapshot không có `.github/workflows/` hay cấu hình CI khác trong tập file được theo dõi. `npm test` chỉ chạy `tests/*.test.mjs`; không tự chạy Cargo, differential với binary Rust, `test:ui` hay hardware gate offline đang chưa được theo dõi. `package.json` chưa có `engines`; Cargo chưa pin toolchain/MSRV.

Ca cụ thể: người đóng góp chạy `npm test` thành công nhưng thay đổi Rust hoặc đóng gói vẫn hỏng; một máy mới không có thư mục toolchain cục bộ như ví dụ setup. Không có log fresh-clone hiện tại để xác nhận build thành công.

Sửa: CI Windows cài đúng toolchain và dependency khóa phiên bản, chạy riêng Node/Rust/differential/browser; job phần cứng giả lập tách khỏi job có thiết bị thật. Không sửa các oracle cũ chỉ để test xanh. Thực hiện T00, T03.

### A09. Chưa có baseline hiệu suất đủ để ra quyết định

Ưu tiên P1 theo yêu cầu dự án. `tests/fixtures/rust-read-only-parity.json` ghi một lần snapshot native khoảng 3.336 ms và Rust helper khoảng 2.115 ms. Đây là mẫu lịch sử ngày 02/11, không phải benchmark mới, không phải standalone Rust, không đủ để kết luận tỷ lệ tăng tốc.

Luồng legacy ghi gọi snapshot → apply → snapshot; mỗi bước lại resolve/inventory (`bridge/server.mjs`, `bridge/backend.mjs:32`). Inventory tạo tiến trình native và PowerShell; snapshot mở helper và đọc nhiều setting. Standalone Rust cũng chạy worker inventory/inspect có chủ đích để cô lập lỗi. Không thể giả định đổi ngôn ngữ đã loại chi phí này.

Sửa: đo riêng thời gian xếp hàng, inventory, mở worker, HID exchange, xác minh và render; lấy p50/p95/p99 cùng CPU/RSS và số tiến trình. Chỉ tối ưu phần đo được. Giữ khoảng chờ HID 20 ms đến khi có chứng cứ phần cứng cho phép đổi. Chi phí stringify/localStorage toàn thư viện mỗi lần sửa macro cũng cần đo tại 50.000 event trước khi chọn cách lưu khác. Thực hiện T05, T09.

### A10. Thiếu hồ sơ phát hành và kiểm kê dependency theo gói thực tế

Ưu tiên P1. Có lockfile nhưng chưa có SBOM, quy trình tạo portable bundle được kiểm tự động, checksum/chữ ký release hay chính sách cập nhật bảo mật trong repo. Setup chỉ hướng dẫn copy executable và notices.

`package-lock.json` còn có các gói sharp/libvips mang LGPL trong dependency phát triển. Điều đó không tự buộc mã dự án chuyển sang LGPL: phải xác định gói nào thực sự được phân phối, ở dạng nào, nghĩa vụ tương ứng. Rust binary cần kiểm cả dependency bắc cầu và thư viện liên kết; metadata package không thay cho giấy phép của nội dung thực tế.

Sửa: kiểm kê riêng web assets, companion binary và công cụ build/test; tạo SBOM + thông báo giấy phép từ đúng dependency/artifact của bản phát hành; kiểm gói không có test server, secret hay capture. Quét advisory với timestamp và nguồn dữ liệu, không coi việc không quét là không có CVE. Thực hiện T01, T03, T12.

### A11. Tài liệu công khai phụ thuộc hồ sơ và đường dẫn nội bộ

Ưu tiên P1 cho khả năng tiếp quản. `docs/setup.md` dẫn `evidence/rust-companion-2026-11-09/task-4-handoff.md`, nhắc receipt task 6 và toolchain `D:/Razer-agents-20261102/...`. `git ls-files docs` lúc bắt đầu chỉ trả `docs/setup.md`. `.gitignore:34` bỏ qua toàn bộ docs khác.

Ca cụ thể: người clone repo không mở được tài liệu recovery được dẫn và không có toolchain theo ví dụ. Sơ đồ model trỏ về nguồn `designs/` cũng không được phân phối. Người mới không thể tái lập đầy đủ bằng chứng hoặc xác minh provenance từ repo.

Sửa: viết hướng dẫn tự chứa cho build/recovery bằng toolchain công khai; xuất bằng chứng đã khử dữ liệu riêng; chỉ mở whitelist tài liệu cần phát hành. Trong lượt rà soát này đã mở whitelist riêng cho báo cáo, manifest, roadmap và kế hoạch; chưa công khai capture hay sửa tài liệu setup đang được người dùng chỉnh. Thực hiện T00, T11.

### A12. Thiếu quy ước bảo trì và hỗ trợ bản phát hành

Ưu tiên P1 trước nhận đóng góp/phát hành ổn định. Chưa có `SECURITY.md`, `CONTRIBUTING.md`, quy tắc owner, ma trận hỗ trợ hay quy trình ngừng hỗ trợ. Pairing kiểm backend/write mode nhưng chưa thương lượng version API/schema; web và companion có thể cập nhật độc lập.

Ca cần phòng: web mới gửi schema mà companion cũ hiểu khác; người dùng không có ma trận để xác định cặp tương thích hoặc kênh báo lỗi an toàn. Log hiện chủ yếu phục vụ console, chưa có bản chẩn đoán đã khử token/device identifier và đo queue để hỗ trợ ca chậm kéo dài.

Sửa: ghi rõ version được hỗ trợ, hợp đồng tương thích, owner xử lý lỗi, cách gửi báo cáo đã khử dữ liệu riêng. Version không tương thích phải khóa ghi và hướng dẫn cập nhật. Không thêm telemetry mạng mặc định. Đây là công việc vận hành dự phòng, chưa có bằng chứng cặp version hiện tại bị sai. Thực hiện T11, T12.

## Điều kiện mã nguồn mở

OSI phê duyệt giấy phép; dự án thường chọn giấy phép đã được phê duyệt và áp dụng cho phần nội dung có quyền cấp phép. Không cần dự án đạt benchmark, có installer hoặc vượt kiểm định chất lượng để dùng một giấy phép như vậy. Public repo, miễn phí sử dụng và `private: true` trong npm đều không quyết định mã có là open source hay không. [OSI FAQ](https://opensource.org/faq).

| Việc | Vai trò | Trạng thái |
| --- | --- | --- |
| Xác định quyền với mã/assets/đóng góp | Điều kiện để cấp quyền hợp lệ | Chưa đủ hồ sơ công khai |
| Chọn và kèm license với phạm vi rõ | Điều kiện công bố giấy phép | Chưa chọn |
| Đáp ứng nghĩa vụ dependency | Điều kiện phân phối phần tương ứng | Chưa hoàn tất; GSAP cần quyết định riêng |
| Loại dữ liệu riêng, secret, file trích xuất không được phép | Điều kiện cho gói dự kiến phát hành | Có gitignore; chưa quét toàn lịch sử/artifact |
| CI, benchmark, soak, binary ký số | Tiêu chuẩn chất lượng do dự án đặt | Chưa có bằng chứng hoàn tất |
| DCO, hướng dẫn đóng góp, SECURITY | Quy tắc cộng đồng/bảo trì nên có | Chưa có |
| REUSE/SPDX và SBOM | Công cụ chứng minh phạm vi/nghĩa vụ | Chưa có |

Đề xuất để chủ dự án lựa chọn: Apache-2.0 cho mã tự viết nếu muốn cho phép dùng thương mại và có điều khoản cấp quyền sáng chế rõ; MIT nếu muốn văn bản ngắn hơn. Apache-2.0 không cấp quyền nhãn hiệu. Nếu yêu cầu bản phân phối sửa đổi phải công bố mã tương ứng, cần đánh giá lựa chọn copyleft riêng. Báo cáo không tự áp giấy phép thay chủ sở hữu. [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0), [MIT](https://opensource.org/license/mit).

Giữ tên Peripheral Workbench và mô tả tương thích; kiểm tra logo, hình dáng asset và cách nhắc Razer theo quyền thực tế. Disclaimer không tự cấp quyền sử dụng tài sản bên thứ ba. Việc reverse engineering còn phụ thuộc cách có được nguồn và điều khoản/pháp luật áp dụng; repo hiện không đủ để đưa kết luận pháp lý cho phần đó. [Razer trademark guidelines](https://www.razer.com/legal/trademark-use-guidelines).

Có thể dùng REUSE để gắn copyright/license theo file, kể cả file không chèn được header; dùng DCO để ghi nhận người đóng góp có quyền gửi phần việc của họ. Đây là lựa chọn quản trị, không phải chứng nhận chất lượng hay thủ tục bắt buộc chung của OSI. [REUSE 3.3](https://reuse.software/spec-3.3/), [DCO 1.1](https://developercertificate.org/).

## Những gì chưa nên ưu tiên

Chưa cần rewrite giao diện, đổi framework, thêm cloud account, đồng bộ đa máy, macro playback hoặc hỗ trợ hàng loạt model. Chưa có dữ liệu đủ để chọn worker pool, chạy song song HID, cache bỏ qua kiểm tra identity hoặc giảm delay giao thức. Từng tối ưu phải giữ nguyên kiểm tra trước ghi và cơ chế giữ unknown outcome.

Không gọi session adapter là dead code chỉ vì đường sản phẩm đang tắt: nó còn được test và dùng làm tài liệu nghiên cứu. Chỉ tách khỏi gói runtime sau khi rà hết caller/fixture. Không có ước lượng dòng mã có thể xóa đủ đáng tin để đưa ra ở thời điểm này.

## Kết luận phục vụ thực hiện

Ưu tiên trước mắt: T00 xác lập baseline kiểm thử; T04 khóa đường ghi chưa được kiểm chứng; T07/T08 sửa rủi ro dữ liệu macro; T01/T02 giải quyết phạm vi giấy phép. T05 đo hiệu suất chạy sớm để dẫn T06/T09, nhưng không đổi mặc định backend trước bằng chứng phần cứng.

Xem [roadmap](../roadmap.md) cho thứ tự và cổng nghiệm thu; xem [kế hoạch thực hiện](../superpowers/plans/2026-11-13-stability-open-source.md) cho phạm vi từng thay đổi, lệnh kiểm tra và điều kiện dừng. Mọi trạng thái chưa kiểm thử vẫn là chưa kiểm thử, kể cả khi đã có script hoặc fixture tương ứng.
