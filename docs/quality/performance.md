# Baseline hiệu suất

Ngày đo: 17/11/2026, Asia/Saigon. Phần này đo UI macro trên máy tham chiếu; benchmark companion của T05, đo thiết bị thật và soak vẫn chưa hoàn tất.

Baseline là commit `eb2b9e70359972845aeacef1e8280f51361ab33d`. Ứng viên chỉ đổi cách cập nhật UI: dùng kết quả validation trong cùng một lần render/sync và bỏ sync trùng ở input. Parser, validation tại storage/import/export, schema, giới hạn dữ liệu và chính sách lưu không đổi. Không cache validation qua các lần sửa dữ liệu.

## Phương pháp

Ba cặp baseline/ứng viên chạy xen kẽ, 20 warm-up và 100 mẫu giữ lại cho mỗi stage trong mỗi lượt. Dữ liệu có 0, 1 hoặc 100 macro; mỗi macro có 500 key event với tên/input dài nhất. Case escaped dùng lone surrogate hợp lệ trong JSON, backup tối đa 15.844.036 byte. Percentile dùng nearest-rank, p95/p99 tính riêng từng lượt.

Playwright 1.64.1, Chromium 156.0.8078.4, Node 24.19.0; Windows build 26200, Intel i5-13420H, 12 logical processors, RAM khoảng 16 GB, power scheme Balanced; driver ghi BatteryStatus=2 nhưng chưa đo nguồn AC/DC độc lập. Npm version không thu được trong driver lịch sử do `spawnSync npm.cmd EINVAL`; không điền ngược một giá trị chưa đo. Tải nền và mọi trạng thái hệ thống khác chưa được kiểm soát.

Browser context và HTTP loopback đều do harness sở hữu; companion và các origin ngoài bị chặn. Input là event tổng hợp qua handler thật. Handler/layout và thời gian tới animation frame kế tiếp được đo riêng; frame callback chạy trước paint nên đây không phải độ trễ gõ phím vật lý tới màn hình.

## Kết quả thư viện 100 × 500

Các khoảng là p95 của ba lượt, đơn vị ms. Dữ liệu p50/p95/p99 và toàn bộ cờ so sánh nằm trong [báo cáo JSON](macro-performance.json).

| Dữ liệu / thao tác | Baseline handler/layout | Ứng viên handler/layout | Baseline tới frame | Ứng viên tới frame |
| --- | ---: | ---: | ---: | ---: |
| ASCII render | 114,3–115,8 | 42,6–44,2 | 123,0–126,7 | 50,6–52,4 |
| ASCII tên | 100,5–106,4 | 38,2–41,5 | 113,3–121,8 | 54,1–61,9 |
| ASCII phím | 100,9–103,9 | 37,6–39,6 | 116,1–119,7 | 55,2–56,0 |
| ASCII độ trễ | 99,5–103,3 | 35,9–36,5 | 112,7–116,8 | 52,6–54,2 |
| Escaped render | 104,2–110,0 | 44,7–45,2 | 113,5–137,8 | 51,4–53,7 |
| Escaped tên | 146,2–151,4 | 85,0–87,3 | 150,5–174,7 | 88,1–90,7 |
| Escaped phím | 144,7–151,7 | 86,2–87,4 | 148,4–179,8 | 89,9–91,1 |
| Escaped độ trễ | 144,6–146,4 | 86,9–87,6 | 148,7–150,4 | 91,1–91,3 |

Cả 16 tổ hợp UI lớn đều cải thiện p95 và p99 trong từng cặp. Các p95 được đo ở ứng viên đều dưới mục tiêu đề xuất 100 ms trên máy này. Native save của case escaped thất bại quota ở toàn bộ mẫu; UI giữ draft trong RAM và báo chưa lưu. Những thời gian đó là đường lỗi, không phải thời gian lưu bền thành công.

## Cờ và giới hạn còn lại

Báo cáo giữ cả 69 so sánh, không bỏ cờ theo noise floor. Có ít nhất một cặp tăng trên 10% ở 14/35 tổ hợp microbenchmark không đổi mã và 4/18 tổ hợp UI nhỏ/rỗng. Đáng chú ý, p99 native library save của case escaped ở cặp 2 tăng 76,6 lên 87,7 ms, dù median của ba p99 chỉ tăng khoảng 0,5%. Không coi mọi cờ này là nhiễu dưới mili giây, và không nghiệm thu điều kiện không regression trên toàn bộ hệ thống từ kết quả này.

PerformanceObserver ghi nhận task trên 50 ms, gồm warm-up và có thể phần setup. Gán task vào stage chỉ gần đúng theo khoảng thời gian; số task không phải số event chính xác. Các task dài vẫn còn trong thao tác lớn, nhất là serialize/lưu; chưa bổ sung worker hay đổi quy tắc lưu để che chúng.

Raw samples, driver lịch sử và verifier được giữ trong `test-results/performance/`; báo cáo công khai lưu hashes và metadata đã loại đường dẫn hồ sơ. Driver lịch sử là `6eb016db7d124af33b799d3f532e20025e718ff8cf6ed3c6c4f4d40cd40195f3`; công cụ public được sửa phần CLI/output/metadata sau các lượt đo, nên không gán số liệu cũ cho hash driver mới.

## Chạy lại phép đo

Cài dependency theo lockfile và Chromium của Playwright trước khi chạy. Chọn thư mục output mới; harness từ chối cả thư mục rỗng đã tồn tại để giữ bằng chứng cũ.

```powershell
node scripts/benchmark-macros.mjs --output test-results/macro-benchmark
```

Có thể dùng `--source-root` trỏ tới một checkout khác khi so sánh hai phiên bản. Mặc định là 20 warm-up, 100 mẫu và 3 lượt; các biến `MACRO_WARMUP`, `MACRO_SAMPLES`, `MACRO_ROUNDS` hỗ trợ smoke. Dưới 100 mẫu không báo percentile. Dùng cùng driver, browser và phương pháp cho hai phía; giữ raw.json và source hashes trước khi đổi mã. Harness public giữ một snapshot byte bất biến của public source trong RAM và chỉ phục vụ snapshot đó; sửa/xóa/thêm file sau khi chụp không được dùng trong lượt đo hiện tại. Muốn đo mã mới phải chạy lượt khác. Lockfile của source và của checkout chứa driver được ghi riêng, cùng version và hash package.json thực tế của Playwright.

Công cụ chỉ dùng dữ liệu giả, origin loopback do nó sở hữu và browser context mới. Request tới companion hoặc origin ngoài, cùng WebSocket, bị chặn. Nó không dùng kho macro hoặc profile browser đang có của người dùng. Đây là harness UI macro; chưa phải toàn bộ benchmark companion của T05.
