# Kế hoạch thực hiện ổn định và mã nguồn mở

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Chỉ triển khai khi có yêu cầu thực hiện; tài liệu này không cấp quyền ghi thiết bị, chọn license thay chủ sở hữu hoặc phát hành.

Goal: Có bản Peripheral Workbench có quyền phân phối rõ, giữ dữ liệu đúng, kiểm soát được lỗi thiết bị và hiệu suất có số đo lặp lại.

Architecture: Giữ web tĩnh và companion cục bộ. Dùng standalone Rust hiện có làm ứng viên lâu dài sau kiểm chứng; giữ cô lập worker, identity guard và recovery. Thực hiện từng thay đổi nhỏ có kiểm thử riêng, không viết lại toàn dự án.

Tech stack: JavaScript ES modules, Node.js 24 trở lên, Cloudflare Worker, Rust trên Windows, Win32/HID, Playwright, PowerShell 7.5 cho hardware gate offline hiện có.

Spec: [Báo cáo 13/11/2026](../../audits/2026-11-13-project-audit.md), [roadmap và tiêu chí đo](../../roadmap.md). Source gốc được khóa bởi [manifest](../../audits/2026-11-13-source-manifest.json).

## Ràng buộc chung

- Thứ tự ưu tiên: đúng thiết bị và không mất dữ liệu → phục hồi đúng → giới hạn tài nguyên → tốc độ → thêm chức năng.
- Một người dùng Windows, 1–4 thiết bị, 1–5 tab là tải sử dụng mục tiêu. Chưa mở hỗ trợ model ngoài `1532:00DE`/`00DF`.
- Không phát lại setter sau timeout; không tự fallback transport; không tự xóa journal; không tự restore khi chưa biết kết quả.
- Không hủy worker đang có thể ghi chỉ vì HTTP client đã đóng. Giữ quyền sở hữu đến khi worker kết thúc và trạng thái đã ghi bền.
- Không dùng cache để bỏ kiểm identity/attachment, expectedValue hoặc getter xác nhận ghi.
- Không giảm khoảng chờ giao thức 20 ms hoặc bỏ kiểm tra response để lấy số benchmark đẹp.
- Giữ reduced motion, thao tác bàn phím, focus và nhãn phân biệt dữ liệu giả lập/ACK/readback.
- Không sửa hay gom thay đổi đang có của người dùng vào task khác. Không tự thêm capture hoặc mã trích xuất Synapse vào repo.
- Không thêm dependency runtime nếu CSS, Web API hoặc stdlib đã đáp ứng. Dependency phục vụ license/benchmark/CI phải có lý do và version khóa.
- Mỗi task kết thúc bằng diff được review, test phù hợp và một commit riêng khi người thực hiện có quyền commit. Không tự push/deploy từ kế hoạch này.
- Các file được ghi là "tạo" bên dưới là đầu ra tương lai. Chỉ mở whitelist `.gitignore` cho đúng tài liệu cần phân phối, không mở toàn bộ `docs/`.

## Quy tắc bằng chứng và môi trường

Mỗi lần nghiệm thu lưu source commit hoặc manifest của dirty tree, hash lockfile/binary, version toolchain, OS/browser/firmware, lệnh, exit code, số pass/fail/skip và thời gian. Bằng chứng raw giữ riêng; bản công khai loại token, serial, USB path và đường dẫn hồ sơ người dùng. Thiếu một suite bắt buộc được ghi là BLOCKED, không đổi thành PASS hoặc skip âm thầm.

Test dùng thiết bị giả phải chạy trên worker/VM dùng riêng với môi trường giả, không gắn HID thật, không secret và không thông ra mạng trong giai đoạn chạy mã dự án. Provision toolchain/dependency có khóa phiên bản trước, sau đó cách ly test. Với bài kiểm tra bảo mật, áp thêm giới hạn CPU/RAM/process/disk/thời gian và source/toolchain chỉ đọc; nếu cần build, copy source vào vùng scratch. Không chạy stress lên companion người dùng đang mở.

Test phần cứng thật là một quy trình lab riêng sau duyệt model, firmware, setting và thao tác khôi phục. Không dùng lệnh trong T10 trên máy/thiết bị chưa được chỉ định. Chưa có runtime test nào được thực hiện trong lượt viết kế hoạch này.

## T00. Khóa baseline và tái lập lỗi hiện tại

Phụ trách: người kiểm chứng. Phụ thuộc: không. Phát hiện: A08, A11. Phạm vi: đọc `package.json`, `Cargo.toml`, `docs/setup.md`; review ba file hardware gate chưa tracked; tạo `docs/quality/baseline.md` và manifest kết quả đã khử dữ liệu riêng.

- [ ] Đối chiếu 140 hash trong manifest; ghi sai khác do công việc tiếp diễn. Tách commit của phần hardware gate đang làm dở trước khi dùng làm baseline chính thức, hoặc giữ candidate manifest riêng nếu chưa thể tích hợp.
- [ ] Dựng Windows VM sạch, ghi `node --version`, `npm --version`, `rustc -vV`, `cargo --version`, `$PSVersionTable.PSVersion`; dùng toolchain công khai thay đường dẫn task-local.
- [ ] Provision bằng `npm ci` và dependency Cargo theo lockfile; ghi lỗi cài đặt riêng. Sau provision, cách ly mạng và chuẩn bị cache cho build offline.
- [ ] Chạy Node, Cargo, build và browser mock theo lệnh dưới; kiểm exit code ngay từng lệnh. Đây là lệnh dự kiến, chưa có kết quả trong báo cáo.

```powershell
npm test
cargo test --offline --locked --manifest-path bridge/rust/Cargo.toml
npm run build
node scripts/verify-project-qa.mjs
node --test tests/companion-hardware-check.mjs
```

- [ ] Chạy lại ca lỗi riêng để phân biệt lỗi sản phẩm, thiếu toolchain và nhiễu môi trường; không nới assertion để "làm xanh". Lưu cả lỗi và skip.
- [ ] Nghiệm thu: người khác dùng fresh clone và hướng dẫn chuẩn lặp được kết quả. Quay lui: chỉ bỏ thay đổi cấu hình của task; giữ baseline lỗi, không chỉnh dữ liệu người dùng.

## T01. Chốt quyền sở hữu và giấy phép

Phụ trách: chủ dự án cùng người rà quyền. Phụ thuộc: T00 về phạm vi source. Phát hiện: A01, A02, A10. Tạo `docs/legal/provenance.csv`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, `REUSE.toml` và license texts phù hợp; sửa metadata package/Cargo/README sau quyết định.

- [ ] Lập từng dòng `path,origin,author,license,evidence,distribution,decision` cho source, fixture, SVG, vendor và thành phần nhúng trong binary. Mọi mục thiếu quyền giữ trạng thái chưa được phép phát hành.
- [ ] Đối chiếu phần dựng từ Synapse với hồ sơ có được nguồn, phiên bản EULA áp dụng và quyền liên quan. Không công khai nội dung proprietary làm bằng chứng. Trường hợp chưa rõ chuyển người đủ chuyên môn xem xét, hoặc loại thành phần khỏi gói dự kiến.
- [ ] Ghi quyết định của chủ thể có quyền: đề xuất Apache-2.0 cho mã tự viết, MIT là lựa chọn ngắn hơn; yêu cầu copyleft cần quyết định riêng. Chưa có quyết định thì dừng riêng bước áp license, vẫn làm các task kỹ thuật độc lập.
- [ ] Kèm nguyên văn license chính thức, copyright đúng chủ thể, SPDX trong metadata; với Apache giữ/thu thập NOTICE khi nghĩa vụ thực tế yêu cầu. Không viết lại license để cấm thương mại hoặc lĩnh vực sử dụng.
- [ ] Chia inventory thành web assets, companion, công cụ build/test. Kiểm riêng GSAP và sharp/libvips; không suy license của gói cuối chỉ từ `devDependencies`.
- [ ] Kiểm `reuse lint` bằng version công cụ đã pin; kiểm gói thật có đủ license texts/notices và không có đường dẫn tác giả bịa. Kết quả máy quét chỉ hỗ trợ kiểm quyền, không thay quyết định quyền sở hữu.
- [ ] Nghiệm thu: mọi file phân phối có nguồn/quyền rõ, metadata khớp license, chủ thể ký quyết định phạm vi. Quay lui: chưa phát hành nếu còn thiếu; license đã cấp công khai phải xử lý theo điều khoản thực tế, không giả định có thể thu hồi bằng một git revert.

## T02. Bỏ GSAP nếu chọn gói hoàn toàn mã nguồn mở

Phụ trách: giao diện. Phụ thuộc: quyết định phạm vi T01. Phát hiện: A02. Sửa `public/motion.js`, `public/style.css`, `public/index.html`, `package.json`, `package-lock.json`; bỏ `scripts/sync-vendor.mjs` và `public/vendor/gsap/` khi không còn caller; kiểm `scripts/verify-ui.mjs` và browser QA.

- [ ] Tìm mọi `gsap`, `Flip`, `sync-vendor`, `initMotion`, `moveIndicator`, `indicatorPosition`, `feedback` trong source/test/config; giữ chữ ký export đang được gọi.
- [ ] Thêm ca browser chạy không có global GSAP/Flip: mọi route dùng được, indicator đúng tab, focus không nhảy, dialog đóng/mở được, reduced motion không animate.
- [ ] Dùng CSS cho hover/press; dùng Web Animations API nếu cần chuyển vị trí indicator. Hủy animation cũ trước animation mới và khi pagehide; không tạo framework animation.

```js
// Hình thức thực hiện trong feedback(); kiểm null/reduced motion trước nhánh này.
target.animate(
  [{ opacity: 0.7, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
  { duration: 180, easing: 'ease-out' }
);
```

- [ ] Bỏ script tags, package và lifecycle predev/prebuild chỉ phục vụ vendor; cập nhật lockfile bằng npm. Xóa vendor sau khi rà caller, giữ bản lịch sử Git và notice cho bản phát hành cũ nếu còn phân phối.
- [ ] Chạy `npm test`, `npm run build`, `node scripts/verify-project-qa.mjs` và UI QA trên dev server do test sở hữu. Kiểm artifact không còn tải GSAP.
- [ ] Nghiệm thu: tương tác/accessibility giữ nguyên, không dependency thay thế, inventory T01 cập nhật. Quay lui: phục hồi cả mã, package và notice cùng nhau; khi quay lại GSAP, cổng "toàn bộ mã nguồn mở" đóng lại.

## T03. CI có kiểm đủ các đường triển khai

Phụ trách: phát hành/kiểm chứng. Phụ thuộc: T00. Phát hiện: A08, A10. Tạo `.github/workflows/ci.yml`, `rust-toolchain.toml`, `bridge/rust/deny.toml`; sửa `package.json`, `Cargo.toml` và hướng dẫn setup sau khi hợp nhất phần sửa sẵn có.

- [ ] Pin Node 24.x và Rust đúng phiên bản đã build ở T00; thêm `engines.node` và MSRV đã thử. Actions pin theo commit SHA của version được kiểm, không điền SHA đoán.
- [ ] Job Windows chạy Node suite, `cargo fmt --check`, Clippy, Rust tests, production build; job mock không có quyền deploy/token production. Job portable Node có thể thêm sau nếu chi phí thấp.

```powershell
cargo fmt --manifest-path bridge/rust/Cargo.toml --check
cargo clippy --offline --locked --manifest-path bridge/rust/Cargo.toml --all-targets -- -D warnings
cargo test --offline --locked --manifest-path bridge/rust/Cargo.toml
cargo build --offline --locked --release --manifest-path bridge/rust/Cargo.toml --bin razer-companion
```

- [ ] Dựng đúng Cargo test executable, chạy differential và launcher; không dùng production binary thay test server.

```powershell
$cargoRows = @(cargo test --offline --locked --manifest-path bridge/rust/Cargo.toml --test contract-server --no-run --message-format=json)
if ($LASTEXITCODE -ne 0) { throw 'Cargo test-server build failed' }
$artifacts = @($cargoRows | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'contract-server' -and $_.executable })
if ($artifacts.Count -ne 1) { throw 'Expected exactly one contract-server artifact' }
$contractExe = $artifacts[0].executable
node scripts/verify-companion-contract.mjs --candidate-test-server $contractExe
if ($LASTEXITCODE -ne 0) { throw 'Contract comparison failed' }
node scripts/verify-companion-launcher.mjs --candidate-test-server $contractExe
if ($LASTEXITCODE -ne 0) { throw 'Launcher comparison failed' }
```

- [ ] Thêm browser QA và `node --test tests/companion-hardware-check.mjs` thành job bắt buộc riêng trên Windows với PowerShell 7.5. Đây là fake HTTP/offline assertion; không gọi operation thật của hardware verifier.
- [ ] Tách advisory/license scan ra job có mạng đọc database, không secret; pin công cụ, timestamp database, lưu báo cáo cả dependency dev/runtime. Không tự `npm audit fix --force`.
- [ ] Nghiệm thu: cố ý làm sai một fixture trong nhánh test khiến đúng job fail; thiếu binary/browser cũng fail rõ. Bảo vệ nhánh required checks phải kiểm ở cấu hình hosting, không coi YAML tự bật bảo vệ nhánh. Quay lui: sửa job, không bỏ gate để merge thay đổi runtime.

## T04. Khóa ghi chưa được kiểm chứng trên mọi đường sản phẩm

Phụ trách: companion. Phụ thuộc: T00; không chờ T01. Phát hiện: A03. Sửa `bridge/backend.mjs`, `bridge/native-host.cjs`, `bridge/server.mjs`, `scripts/bridge.mjs` và help/setup; mở rộng `tests/bridge.test.mjs`, `tests/rust-transport.test.mjs`, `tests/companion-start.test.mjs`, parity fixtures theo quyết định review.

- [ ] Trace cả `npm start`, `npm run bridge`, legacy native, legacy Rust helper và standalone Rust. Ghi rõ cờ hiện tại của từng đường; không gán nghĩa mới âm thầm cho cờ cũ.
- [ ] Viết test default: snapshot có `writable:false`; POST hợp lệ vẫn bị từ chối trước native setter; fake `apply` counter bằng 0. Thử cả gọi backend trực tiếp và HTTP.
- [ ] Đường legacy chỉ đọc phải kiểm ở backend trước gọi helper; schema UI chỉ là lớp hiển thị. Không sửa API dùng nội bộ test theo cách vô tình mở hardware khi biến môi trường bị kế thừa.
- [ ] Với standalone Rust, giữ `--read-only` ưu tiên hơn `--allow-writes`; quyền ghi giới hạn theo setting/model/firmware đã có evidence. Ghi qua legacy chỉ được xét nếu có cơ chế unknown outcome tương đương đã kiểm; mặc định kế hoạch không dùng legacy làm đường ghi stable.
- [ ] Giữ trạng thái uncertain khi reload/reconnect ở đường stable bằng journal companion hiện có. Browser không được tự cấp lại quyền ghi qua một phiên mới.
- [ ] Kiểm: setting chưa cho phép, firmware chưa xác minh, token đổi, client timeout, helper chết, ACK-only; không trường hợp nào tự gửi lại setter. Chạy Node/Rust contract suites; thay đổi parity mong đợi phải có ghi chú hành vi.
- [ ] Nghiệm thu: fresh clone không ghi phần cứng bằng mặc định; fake tests chứng minh zero dispatch. Quay lui: chỉ quay về bản chỉ đọc, không khôi phục mặc định ghi chưa kiểm chứng.

## T05. Đo baseline trước tối ưu

Phụ trách: hiệu suất/kiểm chứng. Phụ thuộc: T03. Phát hiện: A09. Tạo `scripts/benchmark-companion.mjs`, `tests/benchmark-companion.test.mjs`, `docs/quality/performance.md`; thêm đo thời gian nội bộ nhỏ ở `backend.mjs`, `coordinator.rs`, `worker.rs` nếu harness ngoài không tách được các giai đoạn.

- [ ] Chọn máy chuẩn và fixture chuẩn; ghi OS/CPU/RAM/nguồn điện/browser/toolchain/binary/firmware. Tách native legacy, legacy Rust helper, standalone Rust; không dùng tên "Rust" chung cho hai đường.
- [ ] Giao diện harness nhận endpoint của test server do nó sở hữu, số warm-up và số mẫu; mặc định chỉ fake/read-only, từ chối endpoint production nếu chưa có chế độ lab rõ ràng.
- [ ] Thu `queue_ms`, `inventory_ms`, `worker_start_ms`, `hid_ms`, `verify_ms`, `total_ms`, `rss_bytes`, `handle_count`, `child_count`, timeout/error counts. Không log token hoặc HID path.
- [ ] Kiểm hàm percentile bằng vector cố định; n nhỏ không xuất p99 như kết luận đáng tin. Làm 20 warm-up và ít nhất 100 read cho baseline; ba lượt tương đương để kiểm độ nhiễu. Số lần ghi thật theo duyệt lab riêng, không áp máy móc 100 lần cho thiết bị.

```js
// Ca tự kiểm cho cách tính nearest-rank percentile của harness.
const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];
const samples = Array.from({ length: 100 }, (_, i) => i + 1);
assert.equal(percentile(samples, 0.95), 95);
assert.equal(percentile(samples, 0.99), 99);
```

- [ ] Đo UI tại 0/1/100 macro, 500 event/macro; tách stringify, localStorage, render và xử lý phím. Lưu raw sample, không chỉ trung bình.
- [ ] Nghiệm thu: bảng baseline lặp được, mọi số có source hash và kích thước mẫu; quyết định chấp nhận hoặc chỉnh mục tiêu 3 s/10 s của roadmap kèm nguyên nhân. Quay lui: tắt instrumentation nếu gây nhiễu, giữ harness ngoài và baseline cũ.

## T06. Giới hạn queue/kết nối và dọn đọc hết hạn

Phụ trách: companion. Phụ thuộc: T03, T05. Phát hiện: A06. Sửa `coordinator.rs`, `http_server.rs`, `http.rs`; kiểm cùng hợp đồng cho `bridge/server.mjs`; thêm ca vào `transactions.rs`, `http_sockets.rs`, `http_contract.rs`, `tests/bridge-refresh.test.mjs` và fixture differential.

- [ ] Dùng fake backend giữ một read bằng gate. Gửi 16 ID khác nhau, cùng-ID lặp, rồi ID thứ 17; ca mới phải chứng minh hiện tại chưa có backpressure. Test riêng 33 socket và slow request.
- [ ] Đề xuất hằng số ban đầu: 16 công việc đọc khác ID kể cả active, 32 kết nối. Không thêm tùy chọn người dùng khi chưa có nhu cầu. Khi đầy, trả 503 có mã `OVERLOADED`; busy write vẫn 409 và không xếp hàng.
- [ ] Kiểm capacity trước insert/increment; khi channel send thất bại phải rollback map/counter và báo unavailable. Giữ same-ID coalescing, không dùng lock đồng bộ để chờ queue có chỗ trên HTTP executor.
- [ ] Đọc chưa bắt đầu không còn subscriber/hết hạn được bỏ trước gọi backend. Đọc đang chạy vẫn giữ owner đến completion. Việc hủy response không được xóa `MayHaveWritten` hoặc nhả lease của writer.
- [ ] Shutdown ngừng nhận việc, bỏ pending reads không còn ích, drain active work theo deadline đã đo; không đẩy shutdown ra sau hàng nghìn read. Kiểm counter/map về trạng thái đúng sau lỗi/panic của backend bằng fault fixture.
- [ ] Nghiệm thu: 1.000 yêu cầu fake không làm queue vượt trần, bộ nhớ trở về plateau, writes không starvation sau drain; 0 setter ngoài transcript dự kiến. Chạy Rust transactions/socket/lifecycle và Node differential. Quay lui: giữ read-only nếu giới hạn mới làm recovery sai; không bỏ trần để che lỗi.

## T07. Một writer macro trên mỗi origin

Phụ trách: giao diện/dữ liệu. Phụ thuộc: T00; kiểm tích hợp qua T03. Phát hiện: A04. Sửa `public/app.js`, `public/macros.js`, `public/macro-view.js`, `public/i18n.js`; mở rộng `tests/frontend-project.test.mjs`, `tests/qa-local-drafts.test.mjs` và browser QA.

- [ ] Thêm ca hồi quy hai instance chung storage. Đoạn sau mô tả kết quả dữ liệu phải giữ; trên thiết kế mới instance B là chỉ đọc nên `create()` không ghi đè A.

```js
let saved = null;
const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
const a = createMacroLibrary(storage), b = createMacroLibrary(storage);
const first = a.create();
b.create();
assert.ok(JSON.parse(saved).macros.some(m => m.id === first.id));
```

- [ ] Dùng `navigator.locks.request` với tên `device-control-macros-v1`, exclusive và `ifAvailable:true`; giữ lock trong suốt phiên sửa, giải phóng khi pagehide. Tải lại storage sau khi nhận lock, trước cho sửa; không ghi thư viện đã đọc trước khi nhận lock.
- [ ] Cho library nhận chính sách được ghi tường minh từ app; test cấp quyền bằng fake lock. Tab không giữ lock hiện trạng thái chỉ đọc, có thao tác thử nhận quyền khi tab kia đóng. Không cho `save()` vượt kiểm quyền.
- [ ] Tab chỉ đọc nhận storage event và reload an toàn. Bản nháp chưa lưu được export trước khi chuyển quyền; không tự merge hai thư viện hoặc bỏ dữ liệu trong bộ nhớ. Khi Web Locks không có, chỉnh sửa chỉ trong bộ nhớ, export để giữ lại và hiển thị rõ giới hạn.
- [ ] Browser test dùng hai page trong cùng context/origin: A lưu, B không ghi được, đóng A, B nhận quyền và đọc bản A rồi mới sửa. Thử page crash, private mode, localStorage throw và dữ liệu hỏng.
- [ ] Nghiệm thu: không mất macro trong chuỗi trên, thông báo persistence đúng, không ảnh hưởng nhập/xuất. Quay lui: giữ read-only hoặc memory-only khi không có khóa; không trở lại last-writer-wins.

## T08. Backup macro round-trip ở giới hạn lớn nhất

Phụ trách: giao diện/dữ liệu. Phụ thuộc: T07. Phát hiện: A05, A09. Sửa `public/macros.js`, `public/macro-view.js`, `public/i18n.js`, `docs/setup.md`; test tại `tests/qa-local-drafts.test.mjs` và browser QA.

- [ ] Viết ca 100 macro × 500 key event, tên/input Unicode hợp lệ dài nhất; export rồi import vào thư viện rỗng phải giữ đúng name/event và tạo ID mới. Thử cả picker để tránh chỉ sửa parser.

```js
const document = { version: 1, macros: Array.from({ length: 100 }, () => ({
  name: 'M'.repeat(64), events: Array.from({ length: 500 }, () => ({
    kind: 'key', input: 'A'.repeat(32), action: 'down', delayMs: 60000
  }))
})) };
const source = JSON.stringify(document, null, 2);
assert.ok(new TextEncoder().encode(source).length > 1_000_000);
assert.equal(parseMacroImport(source).length, 100);
```

- [ ] Chọn `macroLimits.importBytes = 32_000_000` làm trần đề xuất cho format v1 và chứng minh mọi thư viện hợp lệ export bằng serializer hiện tại nằm dưới trần, kể cả escape Unicode. Nếu chứng minh sai, sửa trần trước merge và ghi lý do.
- [ ] Picker và parser dùng đúng hằng số export từ `macros.js`; vẫn chặn file quá lớn trước `text()`/parse. Kiểm 32.000.000 và 32.000.001 byte, depth bất thường, prototype keys, trường thừa và event thực thi trái phép.
- [ ] Storage quota không được biến thành thành công giả: giữ dữ liệu trong bộ nhớ, báo lỗi lưu, vẫn export được. Không xóa thư viện cũ để nhường quota.
- [ ] Dùng T05 đo lại thời gian parse/export/save ở biên. Nếu chặn UI quá ngân sách, dùng worker chỉ cho parse/serialize nặng sau số đo hoặc giảm định dạng thụt lề, không giảm giới hạn bằng cách loại dữ liệu đã hợp lệ.
- [ ] Nghiệm thu: round-trip tối đa và Unicode đạt, nhập sai không đổi thư viện, file vượt trần bị từ chối hữu hạn. Quay lui: giữ khả năng đọc backup format v1 đã phát hành, không tạo file mà bản hỗ trợ hiện tại không nhập được.

## T09. Tối ưu phần đã đo, giữ nguyên an toàn HID

Phụ trách: companion/hiệu suất. Phụ thuộc: T05, T06; T07/T08 cho phần macro. Phát hiện: A09. Sửa đúng bottleneck trong `backend.mjs`, `inventory.mjs`, `physical_backend.rs`, `worker.rs`, `adapter.rs`, `public/macros.js` hoặc `public/app.js`; không mặc định sửa tất cả.

- [ ] Xếp các giai đoạn theo tỷ trọng p95 và CPU; chọn đúng một bottleneck cho PR đầu tiên. Ghi giả thuyết có thể bác bỏ, ví dụ "inventory/spawn chiếm phần lớn read, thay đổi X giảm số lần Y".
- [ ] Giữ cùng-ID coalescing; hợp nhất inventory/read cùng observation khi chứng minh attachment epoch không đổi. Không chia sẻ handle qua worker chỉ để giảm spawn khi chưa có test owner/deadline.
- [ ] Cache chỉ cho metadata hoặc UI read có TTL/timestamp rõ và bị vô hiệu khi hotplug; luồng expectedValue trước ghi vẫn đọc lại. Không bỏ setting hoặc side-effect checks để giảm payload.
- [ ] Nếu synchronous save là bottleneck, giữ writer lease T07 và tách serialize khỏi mỗi phím; UI phải hiển thị chưa lưu cho đến khi durable save thành công. Mất page/crash không được bỏ draft mà trước đó đã báo lưu.
- [ ] Chạy cùng workload baseline/candidate xen kẽ ba lượt, lưu raw sample/error rate/RSS/handles. Regress lifecycle/recovery/conflict cùng commit trước khi lấy kết quả tốc độ làm căn cứ merge.
- [ ] Nghiệm thu: cải thiện đo được ở giai đoạn mục tiêu, không làm p95/p99/RSS vượt ngân sách đã chốt hoặc nới safety. Quay lui: revert PR tối ưu và giữ baseline an toàn; không rút test để bảo vệ tối ưu.

## T10. Kiểm thiết bị thật, lỗi vòng đời và soak

Phụ trách: người kiểm chứng phần cứng, có người review khác. Phụ thuộc: T04, T06, T09 và hardware gate của T00 đã được tích hợp. Phát hiện: A03, A07. Dùng lại `scripts/verify-companion-hardware.ps1`; bổ sung fake tests ở `tests/support/hardware-gates-check.ps1`, `tests/companion-hardware-check.mjs` và Rust lifecycle/physical/recovery khi thêm scenario. Tạo `docs/quality/hardware-matrix.md` với chứng cứ đã khử dữ liệu riêng.

- [ ] Chạy offline gate trước; đối chiếu source pin, executable hash, listener PID/process generation. Không gọi script chỉ vì có thể tìm thấy máy đang gắn chuột.
- [ ] Tạo ma trận: USB ID, model, firmware, wired/dongle, Windows build, setting, getter/ACK, side effects, restore, kết quả, source hash. Missing equipment phải để NOT VERIFIED.
- [ ] G1: sau duyệt đọc, capture legacy rồi Rust read-only trên đúng thiết bị; so đầy đủ schemas/values/unavailable/250 curve samples. Biến thiên battery phải có quy tắc thời gian hoặc trạng thái không đủ điều kiện so sánh, không tùy ý bỏ field để pass.
- [ ] G2 đầu tiên: duyệt DPI hai trục thay đổi đúng 100 trong giới hạn schema; baseline độc lập; apply một lần; getter kiểm; restore là thao tác duyệt riêng. Dùng đúng tham số `-ReadOnly`, `-Setting dpi`, `-RequestedValue`, `-Restore` và các receipt trong setup hiện tại; T11 sẽ chuẩn hóa phần hướng dẫn công khai.
- [ ] Unknown/crash: giữ intent+journal; recovery chỉ đọc để quan sát; không tự khôi phục khi mất response. ACK-only smart tracking chưa đủ điều kiện thì giữ disabled; không dùng một DPI pass để mở mọi setter.
- [ ] Fault matrix: rút/cắm trong read và trước dispatch; hai máy cùng model; đổi USB port; sleep/wake; helper/parent chết; journal ghi lỗi/disk full; Synapse cùng truy cập. Lỗi ghi giả lập dùng fake workers; không cố gây hỏng firmware để lấy fault evidence.
- [ ] Soak 24 h khi tích hợp, 7 ngày cho ứng viên stable: đọc/poll/idle/reconnect, theo dõi RSS/handle/worker và queue; ghi thật chỉ theo phiên lab đã duyệt, không stress ghi liên tục.
- [ ] Nghiệm thu: 0 ghi sai thiết bị, 0 automatic replay, 0 unknown thành success, không worker mồ côi; toàn bộ tổ hợp được công bố hỗ trợ có evidence. Quay lui: đóng capability setter, giữ read-only và journal; bản firmware chưa thử không được thừa hưởng pass.

## T11. Tài liệu tự chứa, version API và chẩn đoán

Phụ trách: companion/phát hành. Phụ thuộc: T00, T03; phối hợp T10 về thuật ngữ recovery. Phát hiện: A11, A12. Tạo `docs/quality/support-matrix.md`, `docs/architecture.md`, `SECURITY.md`, `CONTRIBUTING.md`; sửa setup/README, `public/transport.js`, `bridge/server.mjs`, Rust `http.rs`, launcher `probeCompanion` và tests liên quan.

- [ ] Thay đường dẫn máy phát triển bằng hướng dẫn install/build công khai. Chép nội dung recovery cần thiết thành hướng dẫn tự chứa đã review; không công khai thư mục evidence nguyên khối.
- [ ] Định nghĩa API version 1 và schema version 1 cho hợp đồng hiện tại trong tài liệu. Pairing trả version/capabilities qua JSON để browser đọc được mà không phụ thuộc expose-header CORS. Backend/version thiếu hoặc không tương thích: chỉ đọc chẩn đoán và khóa ghi.
- [ ] Giữ token chỉ trong bộ nhớ; test UI cũ/companion mới và UI mới/companion cũ. Quy định giai đoạn tương thích rõ, không suy hỗ trợ từ cùng nhãn backend. Cập nhật differential với candidate differences được review.
- [ ] Thêm diagnostic export do người dùng chủ động: app/backend/API version, hash binary, error code, timings và queue counters; bỏ token, serial, HID paths và đường dẫn user. Không tự gửi dữ liệu lên mạng.
- [ ] `SECURITY.md` phải chỉ kênh thực có và supported versions; `CONTRIBUTING.md` ghi test, quy tắc không nhập proprietary dumps, DCO nếu chủ dự án chọn, cách tái hiện lỗi mà không cần hardware.
- [ ] Test diagnostic bằng token/serial giả và assert không có trong output; kiểm mọi link nội bộ từ `git ls-files`, không chỉ từ filesystem có docs ignored. Thử người khác chạy build và recovery walkthrough trên VM.
- [ ] Nghiệm thu: fresh clone hiểu được setup/recovery, phiên bản lạ không ghi, support bundle không lộ dữ liệu giả nhạy cảm. Quay lui: khi thương lượng lỗi, fail closed/read-only; giữ tài liệu version tương ứng.

## T12. Đóng gói phát hành và chính sách bảo trì

Phụ trách: phát hành và chủ dự án. Phụ thuộc: T01, T02 nếu chọn bỏ GSAP, T03, T11. Phát hiện: A10, A12. Tạo `scripts/package-companion.ps1`, test đóng gói, workflow release chỉ chạy theo quyền phát hành; tạo `CHANGELOG.md` và `docs/quality/release-checklist.md`.

- [ ] Build duy nhất `--bin razer-companion` cho target Windows đã thử; allowlist gói gồm binary production, hướng dẫn, license texts/notices, SBOM và manifest SHA256. Không copy toàn `target/` hoặc `node_modules/`.
- [ ] Kiểm package không có `contract-server`, `lifecycle-fixture`, session journal, token, private capture hay module Synapse. Test package script với fixture có file cấm để chứng minh không lọt vào ZIP.
- [ ] Tạo SBOM từ đúng lockfile/artifact cho Rust và web. Ghi toolchain, build command, dependency license review, source archive/commit và checksum. Đo khả năng build lặp lại; không gọi reproducible byte-for-byte nếu hai build chưa được so.
- [ ] Ký executable bằng chứng thư hợp lệ của bên phát hành khi có; kiểm chữ ký ở máy sạch. Checksum độc lập vẫn cần. Chưa có chứng thư phải công bố rõ trạng thái chưa ký, không xem checksum là chữ ký hoặc hứa tránh mọi cảnh báo Windows.
- [ ] Smoke-test trên Windows không cài Synapse/Node/Rust cho companion; frontend vẫn cần cách phục vụ được tài liệu hóa. Kiểm phụ thuộc CRT/system DLL trên target thực tế.
- [ ] Đề xuất hỗ trợ hai minor gần nhất trong 6 tháng, rà advisory hàng tuần; chủ dự án chỉ chấp nhận khi có nguồn lực. Phản hồi báo lỗi nghiêm trọng trong 2 ngày làm việc là mục tiêu nội bộ, không hứa thời hạn sửa vô điều kiện.
- [ ] Nghiệm thu: ZIP/manifest/notices/SBOM/source khớp nhau, package sạch, rollback cài lại bản cũ không xóa guard. Quay lui: rút ứng viên khỏi phát hành, lưu provenance; không sửa đè file đã gắn version công khai.

## T13. Review cuối và chuyển mặc định có điều kiện

Phụ trách: chủ dự án + reviewer độc lập. Phụ thuộc: T04, T06–T12; các cổng L/C/S/H liên quan đạt. Phát hiện: A03, A07. Sửa `scripts/bridge.mjs`, `scripts/start.mjs` nếu cần, README/setup và launcher/contract tests. Không tạo backend thứ tư.

- [ ] Reviewer đối chiếu từng tiêu chí roadmap với evidence cùng source hash. Bất kỳ unknown, flaky safety test hoặc thiếu phần cứng nào đều chặn capability tương ứng, không bỏ qua bằng biểu quyết tiến độ.
- [ ] Chọn standalone Rust làm default chỉ sau khi G3 được chấp nhận. Read-only override tiếp tục ưu tiên; setter chưa có evidence vẫn disabled dù backend đã chuyển.
- [ ] Chạy lại cả hai caller launcher, reuse đúng origin/backend/write mode, missing executable, child shutdown, dirty guard, API mismatch và rollback. Không tự fallback sang legacy khi Rust lỗi.
- [ ] Dùng thử ứng viên chỉ đọc trước; mở từng setter đã được xác minh cho nhóm lab; theo dõi bug report trước stable. Ghi phiên bản/firmware và giới hạn trong changelog.
- [ ] Thực hành rollback: ngừng Rust, chờ worker, xử lý guard theo recovery, chọn bản tương thích; không phát lại settings. Nếu mục tiêu là giữ trạng thái an toàn, quay về read-only trước khi chọn đường runtime khác.
- [ ] Nghiệm thu: người có quyền ký checklist R, runtime tests/benchmark/soak của đúng binary đầy đủ; chỉ khi đó thực hiện release bằng quy trình được người dùng cho phép riêng. Sau phát hành, không coi T13 là hoàn tất vĩnh viễn: thay đổi giao thức/lifecycle phải mở lại gate liên quan.

## Tiêu chí review mỗi thay đổi

- [ ] Tất cả caller/test/fixture/config/export bị ảnh hưởng đã được tìm và cập nhật.
- [ ] Ca hồi quy thất bại trên baseline phù hợp và đạt trên bản sửa; tài liệu pháp lý có kiểm nguồn/quyền thay cho test chức năng.
- [ ] Không làm yếu identity, readback, validation, storage durability hoặc unknown outcome.
- [ ] Không thêm abstraction/dependency/option chỉ để dùng sau này.
- [ ] Có bằng chứng thực thi đúng phạm vi, mô tả phần chưa kiểm và đường quay lui không làm mất dữ liệu.
- [ ] Tên/mô tả thay đổi nói đúng kết quả cuối; không gộp chỉnh sửa đang có của người khác.

## Phạm vi hoàn tất của lượt lập kế hoạch

Lượt này tạo báo cáo, roadmap, kế hoạch và manifest nguồn; thêm link README và whitelist hẹp cho các tài liệu đó. Chưa thực hiện T00–T13, chưa áp license, chưa sửa runtime, chưa đổi backend mặc định, chưa ghi thiết bị và chưa phát hành. Bắt đầu triển khai bằng T00/T04, đồng thời thu hồ sơ quyền cho T01.
