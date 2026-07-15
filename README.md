# Vovinam Scoring MVP

Server demo logic chấm điểm đối kháng Vovinam:

- Mỗi sân có bảng điểm realtime riêng.
- Trang chính `/` là dashboard vào màn quản lý 6 sân chung.
- Tổng chỉ có 6 sân vật lý, không tách thành 6 sân đối kháng + 6 sân hội diễn.
- Luồng mới: `Dashboard -> Quản lý 6 sân -> Chọn sân -> Chọn Đối kháng/Hội diễn nếu sân trống`.
- Màn chọn sân hiển thị trạng thái `Trống`, `Đối kháng`, `Hội diễn`.
- Có thể `Giải phóng sân` để trả sân về trạng thái trống, điểm đã lưu không bị xoá.
- Màn thông tin giải đấu lưu tên giải, nhiều logo giải đấu và nhiều nhà tài trợ.
- Màn `Xếp hội diễn` cho phép chọn batch import, lọc theo `Lứa tuổi` + `Bài quyền` Vovinam và lưu thứ tự thi.
- Màn `Xếp hội diễn` hỗ trợ import danh mục bài quyền từ file Excel/CSV/TSV và xóa danh sách hội diễn đã lưu.
- Đối kháng: `Sân -> Bảng điểm -> Bảng điểm lớn` và `Sân -> Trọng tài 1/2/3/4 -> Màn hình tổng tài`.
- Hội diễn: `Sân hội diễn -> Trọng tài 1-5 / Bảng điểm hội diễn`.
- Hội diễn dùng 5 trọng tài kéo thanh điểm 0-100, bỏ điểm cao nhất/thấp nhất, tính tổng 3 điểm giữa.
- Mỗi trọng tài hội diễn chỉ gửi kết quả 1 lần cho mỗi bài/sân; reset bài mới gửi lại được.
- Luồng import: `Dashboard -> Import dữ liệu -> Preview dạng bảng`.
- Mỗi sân cố định 4 trọng tài.
- Tối thiểu 3/4 trọng tài bấm cùng bên và cùng điểm thì điểm mới được cộng.
- Trọng tài bấm cùng `side` và cùng `point` trong `1500ms` thì điểm mới được cộng.
- Bảng điểm nhận realtime bằng Server-Sent Events.
- Màn import hỗ trợ `.xlsx`, `.csv`, `.tsv` để xem trước danh sách VĐV.
- Dữ liệu MVP được lưu lâu dài bằng SQLite trong `data/vovinam.db`.
- Import lưu batch dữ liệu vào SQLite và có thể mở lại để preview.
- Có thể sửa ô dữ liệu, thêm/xoá dòng, lưu lại batch import vào SQLite.
- Có thể xoá cả batch import khỏi SQLite.
- Preview có bộ lọc nhanh theo `Lứa tuổi`, `Giới tính`.
- Điểm/log trận cũng được lưu sau mỗi vote, trừ điểm, reset.
- Không cần cài package ngoài.
- Cần Node.js 22.5.0 trở lên vì đang dùng SQLite tích hợp sẵn của Node.

## Chạy thử

```bash
npm start
```

Hoặc:

```bash
node server.js
```

Nếu muốn các máy trọng tài trong cùng WiFi/LAN truy cập, chạy:

```bash
HOST=0.0.0.0 node server.js
```

Mở:

```text
http://localhost:3000/
http://localhost:3000/tournament.html
http://localhost:3000/import.html
http://localhost:3000/arena.html
http://localhost:3000/performance-planner.html
http://localhost:3000/court.html?court=1&matchId=COURT_1
http://localhost:3000/board.html?court=1&matchId=COURT_1
http://localhost:3000/scoreboard.html?matchId=COURT_1
http://localhost:3000/chief.html?court=1&matchId=COURT_1
http://localhost:3000/referee.html?court=1&matchId=COURT_1&judgeId=1
http://localhost:3000/referee.html?court=1&matchId=COURT_1&judgeId=2
http://localhost:3000/referee.html?court=1&matchId=COURT_1&judgeId=3
http://localhost:3000/referee.html?court=1&matchId=COURT_1&judgeId=4
http://localhost:3000/performance-court.html?court=1&matchId=PERFORMANCE_COURT_1
http://localhost:3000/performance-board.html?court=1&matchId=PERFORMANCE_COURT_1
http://localhost:3000/performance-referee.html?court=1&matchId=PERFORMANCE_COURT_1&judgeId=1
```

Test nhanh: mở `Sân 1`, mở TT1-TT4 từ màn sân, rồi cho ít nhất 3 trọng tài bấm cùng `Xanh +1` trong khoảng 1.5 giây. Điểm Xanh sẽ tăng.

## API chính

Gửi điểm:

```http
POST /api/votes
Content-Type: application/json

{
  "matchId": "MATCH_001",
  "judgeId": 1,
  "side": "blue",
  "point": 1
}
```

Lấy trạng thái trận:

```http
GET /api/matches/MATCH_001
```

Lấy trạng thái 6 sân:

```http
GET /api/courts
```

Lấy thông tin giải đấu:

```http
GET /api/tournament
```

Lưu thông tin giải đấu:

```http
PUT /api/tournament
Content-Type: application/json

{
  "name": "Giải Vovinam toàn quốc 2026",
  "logos": [
    {
      "name": "logo.png",
      "type": "image/png",
      "size": 12345,
      "dataUrl": "data:image/png;base64,..."
    }
  ],
  "sponsors": [
    { "name": "Nhà tài trợ A" },
    { "name": "Nhà tài trợ B" }
  ]
}
```

Lấy danh mục bài quyền hội diễn:

```http
GET /api/performance/catalog
```

Lấy các batch bài quyền đã import:

```http
GET /api/performance/routine-batches
```

Import danh mục bài quyền từ file:

```http
POST /api/performance/routine-batches
Content-Type: multipart/form-data
```

Xóa một batch bài quyền đã import:

```http
DELETE /api/performance/routine-batches/:batchId
```

Lấy option lọc hội diễn từ một batch import:

```http
GET /api/performance/planner/options?batchId=:batchId
```

Lọc danh sách hội diễn theo `Lứa tuổi` + `Bài quyền`:

```http
POST /api/performance/planner/filter
Content-Type: application/json

{
  "batchId": "import_001",
  "ageGroup": "15-17",
  "routineId": "long_ho_quyen"
}
```

Lưu thứ tự thi hội diễn:

```http
PUT /api/performance/planner/schedules
Content-Type: application/json

{
  "batchId": "import_001",
  "ageGroup": "15-17",
  "routineId": "long_ho_quyen",
  "entries": [
    {
      "entryId": "row_1",
      "displayName": "Nguyễn Văn A",
      "unit": "TP.HCM",
      "ageGroup": "15-17",
      "routineName": "Long Hổ Quyền",
      "sourceRowIndex": 0,
      "originalOrder": 1
    }
  ]
}
```

Xóa một danh sách hội diễn đã lưu:

```http
DELETE /api/performance/planner/schedules/:groupId
```

Gán sân cho một loại nội dung:

```http
POST /api/courts/1/assign
Content-Type: application/json

{
  "mode": "combat"
}
```

Giải phóng sân:

```http
POST /api/courts/1/release
```

Trừ điểm:

```http
POST /api/matches/MATCH_001/penalty
Content-Type: application/json

{
  "side": "blue",
  "point": 1,
  "reason": "Canh cao"
}
```

Reset trận:

```http
POST /api/matches/MATCH_001/reset
```

Import danh sách VĐV để preview:

```http
POST /api/import/athletes
Content-Type: multipart/form-data
```

Xem lịch sử import đã lưu:

```http
GET /api/imports/athletes
```

Sửa batch import đã lưu:

```http
PUT /api/imports/athletes/:batchId
Content-Type: application/json

{
  "columns": ["Tên VĐV", "Đơn vị", "Hạng cân"],
  "rows": [
    ["Nguyễn Văn A", "Hà Nội", "60kg"]
  ]
}
```

Xoá batch import:

```http
DELETE /api/imports/athletes/:batchId
```

Gửi điểm hội diễn:

```http
POST /api/performance/scores
Content-Type: application/json

{
  "matchId": "PERFORMANCE_COURT_1",
  "court": "1",
  "judgeId": 1,
  "score": 85,
  "deviceLabel": "Máy 1"
}
```

Lấy bảng điểm hội diễn:

```http
GET /api/performance/matches/PERFORMANCE_COURT_1?court=1
```
