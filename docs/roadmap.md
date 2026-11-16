# Roadmap ổn định và mã nguồn mở

Cập nhật ngày 17/11/2026, Asia/Saigon. Phạm vi là Peripheral Workbench trên Windows, bắt đầu với Viper V3 Pro SE `1532:00DE`/`00DF`. Căn cứ: [báo cáo rà soát](audits/2026-11-13-project-audit.md) và [kế hoạch thực hiện](superpowers/plans/2026-11-13-stability-open-source.md).

Thứ tự quyết định: tránh ghi sai thiết bị và mất dữ liệu; phục hồi đúng sau lỗi; vận hành lâu dài có giới hạn tài nguyên; sau đó giảm độ trễ theo số đo. Khối lượng triển khai lớn không phải lý do bỏ một kiểm tra an toàn. Một tính năng chưa có bằng chứng giữ trạng thái experimental hoặc chỉ đọc.

## Các cổng phát hành độc lập

Tiến độ M0 ngày 15/11/2026: đã khóa ghi ở các entrypoint production, launcher và transport của trang web. Ba vòng regression đã tái hiện lỗi rồi sửa; mỗi vòng được theo sau bởi toàn bộ suite đạt. Lượt cuối có 111 test Node, 154 test Rust và 9 test hardware offline, cùng differential, launcher và browser QA. Xem [baseline](quality/baseline.md) và [manifest kiểm chứng M0](quality/m0-validation.json). T01 đã có [danh mục quyền ban đầu](legal/status.md), chưa chọn license. Clone mới từ GitHub đã chạy lại đủ suite trên cùng máy. T00 còn thiếu VM sạch và môi trường cách ly, nên M0 chưa được nghiệm thu hoàn toàn. Các cổng L/C/H/R vẫn chưa đạt; chưa mở ghi phần cứng.

Việc M0 còn mở:

- T00 đã có runner Windows 2025 mới, provision theo lockfile và toolchain công khai, với log/hash nguồn. Còn thiếu môi trường Windows ngắt mạng hoàn toàn: policy CI đã chứng minh chặn TCP trực tiếp của project, nhưng vẫn cho DNS và kênh điều khiển runner hoạt động.
- T01 mới mở danh mục quyền. Quyền phân phối và license chính cần chủ thể có quyền quyết định; phần hoàn tất thuộc M2, cổng L vẫn mở.
- Kết nối GitHub với Cloudflare Workers Builds chưa được kiểm chứng. Lượt M0 đã gặp lỗi quyền OAuth/API và chưa xác minh được dashboard; M1 chưa xử lý phần triển khai này. Deploy thủ công trước đó không chứng minh đã có tự động triển khai.

Tiến độ M1 ngày 17/11/2026: [PR #1](https://github.com/nhan-zunika01/peripheral-workbench/pull/1) đã merge vào `main` tại `52cd1a063334d08180f8b555fbb62c23f081771f`; [CI trên main](https://github.com/nhan-zunika01/peripheral-workbench/actions/runs/43913838429) đạt 4/4 job. Trước merge, CI hosted đạt core, browser, hardware offline và báo cáo dependency; cả 168 hash nguồn trong từng suite khớp Git tree. Ba ca chủ đích fixture sai, thiếu test binary và thiếu browser đều bị từ chối ở đúng gate. `main` yêu cầu đủ bốn checks, strict và áp dụng cả admin. Macro dùng một writer qua Web Locks, giữ draft chưa lưu trong RAM và round-trip đủ 100 × 500 event Unicode qua trần 32.000.000 byte. Xem [checklist](superpowers/plans/2026-11-16-m1-checklist.md) và [bằng chứng M1](quality/m1-validation.json). Policy hosted chặn TCP trực tiếp, giữ loopback, DNS và runner control; T00 vẫn thiếu Windows ngắt mạng hoàn toàn. BFCache thực chưa được xác minh. Website chưa triển khai M1; source/alpha và stable release vẫn cần các cổng bên dưới.

| Cổng | Bằng chứng bắt buộc | Trạng thái hiện tại |
| --- | --- | --- |
| L: mã có giấy phép rõ | Quyền sở hữu, license chính, phạm vi từng thành phần, notices, kiểm gói phân phối | Chưa đạt |
| C: build/kiểm thử tái lập | Fresh clone; Node/Rust/browser/differential/offline hardware checks có log gắn source hash | Hosted CI, artifact/source hash và required checks đã kiểm; còn thiếu cách ly Windows hoàn toàn của T00 |
| S: đọc ổn định | Quá tải hữu hạn, lỗi dữ liệu macro được sửa, crash/reconnect/suspend được kiểm, soak đạt | Chưa đạt |
| H: ghi được xác minh | Ma trận model/firmware/setting, baseline, write/readback/restore và side effects; ACK ghi đúng giới hạn | Chưa đạt |
| R: bản phát hành ổn định | L+C+S, H cho mọi setter được bật, benchmark và rollback được review, gói đúng binary | Chưa đạt |

G1/G2/G3 đã có trong tài liệu phần cứng được giữ nguyên: G1 là đối chiếu đọc, G2 là ghi/khôi phục, G3 là xét chuyển mặc định. Các cổng L/C/S/H/R là cấp dự án và không đổi tên hoặc tự thông qua G1/G2/G3. Cổng H tham chiếu G2; cổng R cần quyết định G3 nếu đổi backend mặc định.

Có thể phát hành source/alpha chỉ đọc sau L+C và công bố giới hạn cụ thể. Bản đó không được gọi là bản ổn định và không mở ghi để bù thiếu bằng chứng. Chỉ chọn license sau khi chủ thể có quyền xác nhận, không gộp lựa chọn pháp lý với quyết định benchmark.

## Các chặng

Ước lượng là ngày công kỹ thuật cho một người làm chính, có người review độc lập. Thời gian mượn thiết bị, đánh giá quyền sở hữu và chờ phiên bản firmware không nằm trong ước lượng. Không thông qua một chặng chỉ vì hết thời gian dự kiến.

| Chặng | Đầu việc | Ước lượng | Điều kiện kết thúc |
| --- | --- | --- | --- |
| M0: baseline và giảm rủi ro tức thời | T00, T04; mở T01 để xử lý quyền sớm | 4–7 ngày | Có baseline nguồn/test; đường ghi chưa được xác minh khóa mặc định |
| M1: giữ dữ liệu và kiểm thử liên tục | T03, T07, T08 | 6–10 ngày | CI không bỏ suite quan trọng; đa tab không ghi đè; backup lớn nhập lại được |
| M2: nguồn mở và bản đo chuẩn | T01, T02, T05 | 5–9 ngày cộng thời gian xác nhận quyền | Cổng L đạt; benchmark có mẫu lặp và bằng chứng theo source |
| M3: giới hạn tải và tối ưu có số đo | T06, T09 | 8–14 ngày | Queue/connection hữu hạn; độ trễ được đo; không yếu đi recovery |
| M4: thiết bị thật và độ bền | T10 | 8–15 ngày công, thêm 7 ngày soak cho ứng viên cuối | G1/G2 và ma trận đã chọn có chứng cứ; tình huống chưa có thiết bị vẫn đánh dấu chưa hỗ trợ |
| M5: hợp đồng hỗ trợ và gói phát hành | T11, T12 | 5–9 ngày | Người mới build/recovery được; API tương thích; gói có source/license/SBOM/checksum |
| M6: chuyển mặc định có điều kiện | T13 | 3–5 ngày cộng thời gian dùng thử | Review bằng chứng đạt; read-only override/rollback hoạt động; cổng R đạt |

Tổng dự trù khoảng 39–69 ngày công, tức khoảng 8–14 tuần làm việc của một người, chưa tính thời gian chờ nêu trên. Đây là khung lập nguồn lực, không phải cam kết hoàn tất. Các phát hiện runtime mới phải được bổ sung trước khi chốt mốc.

## Quan hệ phụ thuộc

```text
T00 → T03 → T05 → T06 → T09 → T10 → T13
  ├─→ T04 ───────────────────→ T10
  ├─→ T07 → T08 ──────────────────→ T13
  ├─→ T01 → T02 ───────→ T12 ────→ T13
  └─→ T11 ─────────────→ T12
```

T01 có thể nghiên cứu song song với kỹ thuật; T02 chỉ bắt đầu khi chủ dự án đã chọn mục tiêu dependency hoàn toàn mã nguồn mở. T05 phải có trước thay đổi hiệu suất. T04 không được chờ license hoặc benchmark. Những việc chung một file phải triển khai tuần tự hoặc trên checkout tách biệt và review khi hợp nhất.

## Mục tiêu đo lường

Các con số bên dưới là ngân sách đề xuất để thử nghiệm, chưa phải kết quả hiện tại. T05 phải xác nhận trên máy chuẩn, ghi cấu hình CPU/RAM/Windows/browser/USB, firmware và hash executable. Không đổi ngưỡng sau khi ứng viên thất bại mà không ghi lý do và review lại.

| Chỉ số | Ngưỡng ban đầu | Phương pháp |
| --- | --- | --- |
| Sai thiết bị, tự ghi lại sau timeout | 0 lần | Đếm dispatch và ID qua mọi ca fault; trên phần cứng chỉ dùng thao tác đã được duyệt |
| Unknown bị coi là thành công | 0 lần | Mất response, crash helper/parent, reload UI, restore thất bại |
| Backup macro | 100% thư viện hợp lệ tại giới hạn được xuất/nhập lại | Bao gồm Unicode, 100 × 500 event và storage đầy |
| Công việc chờ đọc | Tối đa 16 ID khác nhau, gồm công việc đang chạy | Mốc đề xuất; cùng ID dùng chung; quá tải trả lỗi hữu hạn |
| Kết nối companion | Tối đa 32 kết nối đang nhận/xử lý | Mốc đề xuất; kiểm keep-alive, slow body, disconnect và shutdown |
| Ghi khi đã có thao tác | 409, không xếp hàng ghi | Transcript xác nhận không dispatch phụ |
| UI tương tác macro | p95 ≤100 ms; xác định mọi main-thread task >50 ms | Thư viện nhỏ và 50.000 event; đo cả save và redraw |
| Đọc đầy đủ khi ấm | Mục tiêu p95 ≤3 s | Ít nhất 100 mẫu/cấu hình, không bỏ setting để đạt số |
| Apply có getter độc lập | Mục tiêu p95 ≤10 s | Tách inventory, kiểm tra trước ghi, setter, readback và refresh |
| So sánh ứng viên/baseline | Không tăng p95/p99 >10% qua ba lượt đo tương đương nếu không có lý do an toàn được duyệt | Giữ cùng máy, tập dữ liệu, firmware và chế độ nguồn |
| Bộ nhớ/handle/process | Không có xu hướng tăng không giới hạn; sau warm-up RSS tăng ≤10% trong 24 h, không thêm worker mồ côi | Ghi riêng parent/worker/browser; lặp nếu số đo bị nhiễu |
| Độ bền | 24 h khi tích hợp, 7 ngày trước stable | Chủ yếu đọc/poll/idle/reconnect; không lặp ghi thật hàng loạt gây mòn thiết bị |

Mẫu lịch sử 3.336 ms/2.115 ms trong fixture không dùng làm p95. Nếu đọc đủ setting vượt mục tiêu do yêu cầu thiết bị, ghi rõ nguyên nhân và chọn ngân sách khả thi sau review. Không giảm delay HID, bỏ readback, bỏ fsync hay nhả guard sớm chỉ để đạt tốc độ.

## Phạm vi thử phần cứng

Ma trận tối thiểu trước mở ghi gồm hai USB ID hỗ trợ, các đường wired/dongle tương ứng khi có thiết bị, firmware đã xác minh, hai thiết bị cùng model, rút/cắm lại, đổi cổng, sleep/wake, tiến trình chết và Synapse cùng truy cập. Một tổ hợp chưa thử phải hiện là chưa xác minh; không suy rộng bằng fixture.

DPI là setter đầu tiên để chứng minh quy trình với thay đổi nhỏ và khôi phục giá trị cũ. Mỗi setter khác cần baseline/side effects/khôi phục riêng; custom curve và smart tracking cần tiêu chí riêng. Unknown outcome phải giữ journal và dừng ghi. Thay đổi firmware hay packet framing làm mất hiệu lực chứng cứ liên quan và phải chạy lại phần tương ứng.

## Người chịu trách nhiệm

| Vai trò | Quyết định/sản phẩm chịu trách nhiệm |
| --- | --- |
| Chủ dự án/chủ thể có quyền | License, quyền tài sản, phạm vi hỗ trợ, quyết định phát hành |
| Người phụ trách companion | Identity, scheduling, lifecycle, recovery, tương thích giao thức |
| Người phụ trách giao diện/dữ liệu | Lưu macro, backup, trạng thái unknown, accessibility |
| Người phụ trách kiểm chứng | Chạy test độc lập, benchmark, bằng chứng thiết bị, phản biện kết luận |
| Người phụ trách phát hành | Toolchain, SBOM/notices, đóng gói, checksum/chữ ký, rollback |

Một người có thể kiêm nhiệm các phần triển khai. Cổng H và đổi mặc định ở T13 cần người review khác người thực hiện thay đổi. Nếu chưa có reviewer hoặc thiết bị, giữ bản chỉ đọc và ghi trạng thái chưa đạt.

## Trật tự xử lý lỗi sau phát hành

Sai thiết bị, mất dữ liệu hoặc không giữ được unknown outcome chặn phát hành ngay. Phát hiện mới ở đường ghi phải tắt capability liên quan và cung cấp bản chỉ đọc; không đề nghị người dùng xóa journal để mở khóa. Regression hiệu suất được so với baseline cùng cấu hình và xử lý trước khi thêm tính năng.

Rà advisory/dependency mỗi tuần; chạy soak với thay đổi ở HID, lifecycle hoặc lưu trữ. Mỗi bản phát hành ghi version API/schema, thiết bị/firmware đã thử, kiểm thử chưa chạy và hạn chế còn lại. Không lập cơ chế cập nhật tự động executable trước khi có chuỗi xác minh artifact và rollback được kiểm.
