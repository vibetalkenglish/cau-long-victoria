# 🏸 CẦU LÔNG VICTORIA - QUẢN LÝ QUỸ & ĐIỂM DANH

Ứng dụng web hiện đại quản lý tiền sân, tiền cầu, điểm danh buổi chơi và theo dõi đóng tiền của các thành viên CLB Cầu Lông Victoria.

- **Frontend**: Tailwind CSS, HTML5/JS (Chạy độc lập trên Vercel / GitHub Pages / Localhost).
- **Backend / Database**: Google Sheets + Google Apps Script (REST API).

---

## 🚀 HƯỚNG DẪN TRIỂN KHAI LÊN GITHUB & VERCEL

### BƯỚC 1: Lấy URL Web App từ Google Apps Script
1. Mở dự án Google Apps Script của bạn tại [script.google.com](https://script.google.com).
2. Nhấn nút **Deploy** (Triển khai) góc trên bên phải > chọn **Manage deployments** (Quản lý các bản triển khai) (hoặc **New deployment** > **Web app**).
3. Cấu hình cài đặt:
   - **Execute as** (Thực thi dưới tên): `Me (sayoonara.htq90@gmail.com)`
   - **Who has access** (Ai có quyền truy cập): **`Anyone`** *(Bắt buộc chọn Anyone để Vercel có thể kết nối)*.
4. Nhấn **Deploy** và copy đường link **Web app URL** dạng:
   `https://script.google.com/macros/s/AKfycbx.../exec`

---

### BƯỚC 2: Đẩy mã nguồn lên GitHub
1. Mở Terminal tại thư mục dự án và khởi tạo Git:
   ```bash
   git init
   git add .
   git commit -m "feat: setup project for vercel and github deployment"
   ```
2. Tạo một Repository mới trên [GitHub.com](https://github.com/new) (ví dụ đặt tên `cau-long-victoria`).
3. Liên kết và đẩy code lên:
   ```bash
   git remote add origin https://github.com/<tai-khoan-cua-ban>/cau-long-victoria.git
   git branch -M main
   git push -u origin main
   ```

---

### BƯỚC 3: Deploy lên Vercel
1. Đăng nhập vào [Vercel.com](https://vercel.com).
2. Nhấn **Add New...** > **Project**.
3. Chọn Repository `cau-long-victoria` vừa tạo trên GitHub > nhấn **Import**.
4. Giữ nguyên toàn bộ cấu hình mặc định và nhấn **Deploy**.
5. Trong vòng 1 phút, Vercel sẽ cung cấp cho bạn một tên miền miễn phí cực nhanh dạng: `https://cau-long-victoria.vercel.app`.

---

### BƯỚC 4: Kết nối Web App URL trên Vercel
1. Mở trang web Vercel vừa deploy.
2. Nhấp vào nút **API** (màu xanh trên thanh Header).
3. Dán đường link **Web App URL** bạn đã lấy ở **Bước 1** vào ô cấu hình.
4. Nhấn **Test Kết Nối** để xác nhận kết nối thành công, sau đó nhấn **Lưu Cấu Hình**.
5. Dữ liệu Google Sheets sẽ ngay lập tức được đồng bộ theo thời gian thực!

---

## 🔐 ĐĂNG NHẬP QUẢN TRỊ VIÊN (ADMIN)
- **Cách 1 (Dùng mã PIN)**: Nhấn nút **Admin** góc trên bên phải > Nhập mã PIN mặc định: `123456`.
- **Cách 2 (Dùng Email)**: Nhập email: `sayoonara.htq90@gmail.com`.
