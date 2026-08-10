# Tavern Stream Helper

Tiện ích mở rộng frontend độc lập dành cho **SillyTavern phiên bản 1.18.0 trở lên**, dùng để quan sát các yêu cầu chat completion và phản hồi stream, đối chiếu model được báo cáo từ upstream, và sao chép nhanh các input và reply gốc cần thiết để debug.

Tiện ích chỉ đứng ngoài đọc luồng bản sao của request và response, không chỉnh sửa preset, thẻ nhân vật (character card), tin nhắn chat hay output của model, cũng không phụ thuộc vào Tavern Helper, server plugin hay các tiện ích bên thứ ba khác.

## Cài đặt trong SillyTavern

Sao chép link repository GitHub dưới đây:

```text
https://github.com/Despolca/Tavern-Stream-Helper
```

Sau đó hoàn tất cài đặt trong SillyTavern:

1. Mở bảng "Extensions" ở trên cùng.
2. Chọn "Install Extension".
3. Dán link repository ở trên vào ô nhập liệu.
4. Để trống nhánh (branch) hoặc tag để sử dụng nhánh `main` mặc định của repository.
5. Nhấn cài đặt; nếu xuất hiện cảnh báo bảo mật về tiện ích bên thứ ba, hãy xác nhận nguồn an toàn rồi tiếp tục.
6. Sau khi cài đặt xong, hãy đảm bảo "Tavern Stream Helper" trong Extension Manager đã được bật.

Sau khi bật tiện ích, nút "Stream" sẽ xuất hiện ở góc dưới bên phải trang. Gửi một tin nhắn chat, sau đó click vào nút này để xem lịch sử.

Nếu nút không xuất hiện, vui lòng tải lại trang; nếu vẫn không có, nhấn `Ctrl+F5` để buộc tải lại và kiểm tra:

- Phiên bản SillyTavern có đang ở mức từ `1.18.0` trở lên hay không;
- Tính năng UI Extension đã được bật chưa;
- Tiện ích có bị vô hiệu hóa trong Manager không;
- Đã tồn tại thư mục tiện ích trùng tên gây lỗi cài đặt hay chưa.

## Tính năng của Plugin

### Đối chiếu model yêu cầu và model upstream

Plugin sẽ quan sát các request mà SillyTavern gửi đến backend chat completion và lưu lại:

- Tên model trong body của request;
- Tên model và số lần xuất hiện được báo cáo bởi các phân mảnh stream (stream chunks) mang theo body hoặc reasoning text;
- Tên model và số lần xuất hiện được báo cáo bởi toàn bộ SSE chunks;
- Model được báo cáo bởi chunk cuối cùng chứa `usage`;
- ID phản hồi, system fingerprint, nguồn tính phí (usage source) và một số response header nằm trong whitelist an toàn;
- Liệu có sự xung đột giữa request model, model body và model usage hay không.

Khi phát hiện các tình huống sau, lịch sử sẽ hiển thị cảnh báo:

- Response không báo cáo model;
- Có nhiều model lẫn lộn trong các phân mảnh body;
- Request model khác với model chính được báo cáo trong phân mảnh body;
- Model usage cuối cùng khác với model body.

Khi so sánh tên model, plugin sẽ tạo ra một khóa so sánh chuẩn hóa chung: bỏ qua các routing tag trong ngoặc vuông ở đầu và tiền tố đường dẫn của nhà cung cấp, thống nhất Unicode và viết hoa/thường, đồng thời coi các khoảng trắng, dấu gạch ngang, dấu gạch dưới, dấu chấm,... là các dấu phân cách tương đương. Ví dụ: `Claude Opus 4.6`, `[4]claude-opus-4-6`, `ANTHROPIC/claude_opus_4.6` sẽ được coi là cùng một model. Giao diện vẫn sẽ giữ lại và hiển thị tên gốc trả về từ API.

Việc chuẩn hóa này sẽ không tự đoán ngữ nghĩa: trật tự từ khác nhau, thông tin phiên bản khác nhau, hoặc các bí danh marketing không có cấu trúc chung vẫn sẽ bị coi là các model khác nhau, nhằm tránh việc gộp quá đà gây bỏ sót lỗi.

Ví dụ: Request model là `claude-fable-5`, phân mảnh body báo cáo là `claude-opus-4-8`, nhưng usage cuối cùng lại báo là `claude-fable-5`. Plugin sẽ đồng thời đánh dấu cả request model và usage model là không nhất quán với model body.

### Sao chép toàn bộ input gốc

Mỗi bản ghi đều cung cấp nút "Sao chép toàn bộ input gốc". Nội dung sao chép chính là JSON request body mà trình duyệt thực tế gửi đến backend chat completion của SillyTavern, trong đó có thể bao gồm:

- System prompt;
- Chat context (ngữ cảnh chat);
- Tin nhắn của nhân vật và người dùng;
- Tên model và các thông số generate;
- Cấu hình liên quan đến tool hoặc backend.

Plugin sẽ KHÔNG sao chép API Key, Cookie, header Authorization hay toàn bộ request headers.

### Sao chép toàn bộ phản hồi gốc

Plugin sẽ giữ lại toàn bộ response gốc thực tế mà trình duyệt nhận được sau khi giải mã:

- Stream response giữ lại toàn bộ văn bản SSE, bao gồm cả các dòng `data:` và `[DONE]`;
- Non-stream response giữ lại văn bản JSON gốc;
- Trong quá trình generate, có thể copy phần nội dung hiện tại đã nhận được;
- Sau khi người dùng hủy generate, có thể copy phần nội dung đã tới được trình duyệt trước thời điểm hủy.

Dữ liệu mà upstream chưa kịp gửi sẽ không thể khôi phục sau khi người dùng nhấn hủy.

### Tự động dọn dẹp lịch sử

Mặc định, plugin chỉ giữ lại **6** bản ghi gần nhất. Người dùng có thể thay đổi số lượng này trong bảng panel, phạm vi thiết lập từ **1–1000** bản ghi.

Khi vượt quá số lượng đã thiết lập, plugin sẽ tự động xóa bản ghi cũ nhất, đồng thời dọn dẹp luôn văn bản gốc (raw text) trên bộ nhớ tương ứng với bản ghi đó. Khi giảm giới hạn xuống, các bản ghi cũ nằm ngoài giới hạn mới cũng sẽ bị xóa ngay lập tức. Tải lại hoặc đóng trang sẽ xóa toàn bộ bản ghi hiện tại.

### Tùy chỉnh màu vòng số

Vòng tròn đếm số bản ghi trên nút "Stream" mặc định theo màu trích dẫn (quote color) của theme SillyTavern (`--SmartThemeQuoteColor`), và sẽ tự động cập nhật khi đổi theme trong Tavern. Bạn cũng có thể dùng bộ chọn màu trong panel của plugin để ghi đè bằng màu tùy chỉnh; nhấn "Khôi phục màu theme" để quay lại theo theme hiện tại.

### Xuất dữ liệu và Xóa sạch

- "Xuất JSON" sẽ xuất ra các metadata hiện đang lưu như model, số lượng chunk, ID phản hồi, trạng thái,...;
- "Xóa lịch sử" sẽ xóa sạch toàn bộ lịch sử cục bộ và văn bản gốc trong bộ nhớ trang hiện tại;
- File JSON xuất ra KHÔNG bao gồm toàn bộ prompt hoặc toàn bộ phản hồi gốc.

## Lưu trữ dữ liệu và Quyền riêng tư

Lịch sử request, request hoàn chỉnh và phản hồi gốc chỉ được lưu trên **bộ nhớ của trang hiện tại** (memory):

- Sẽ tự động biến mất khi tải lại hoặc đóng trang;
- Các metadata như request model, số lượng chunk, reply ID cũng KHÔNG được ghi vào `localStorage`;
- Không bị gom vào trong file xuất JSON;
- Khi một bản ghi bị tự động dọn dẹp, văn bản gốc tương ứng cũng sẽ bị gỡ khỏi bộ nhớ.

Chỉ có cài đặt giới hạn số lượng bản ghi và tùy chọn màu vòng số mới được ghi vào `localStorage` của trình duyệt hiện tại, để tiếp tục dùng sau khi tải lại trang.

## Hiểu thế nào về "Model thực tế"

"Model thực tế" mà plugin hiển thị được lấy từ trường model mà chính các phân mảnh response của upstream tự khai báo. Đây là bằng chứng định tuyến quan trọng thu thập được từ phía trình duyệt, chứ không phải là kết quả giám định fingerprint của model.

Nếu nhà cung cấp đồng loạt chỉnh sửa hoặc làm giả tên model, reply ID, usage, system fingerprint và response header, plugin KHÔNG THỂ chỉ dựa vào một response trên trình duyệt để chứng minh model nào thực sự đang chạy bên dưới. Để xác nhận chắc chắn, vẫn cần dựa vào log của nhà cung cấp, bản ghi tính phí đáng tin cậy hoặc biên lai upstream có chữ ký.

## Tương thích Response

Plugin không phụ thuộc vào việc server phải điền đúng `Content-Type`. Ngay cả khi response header trống, plugin vẫn sẽ dựa vào response body để thử nhận diện định dạng SSE hoặc JSON, đồng thời ghi lại số lượng sự kiện không thể phân tích (parse errors).

## Giấy phép

Dự án này sử dụng [GNU General Public License v3.0](LICENSE).
