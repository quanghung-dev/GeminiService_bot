# Kế hoạch Tích hợp VietQR API Service (VietQR Tingo)

> **Cập nhật sau vòng thống nhất yêu cầu:** Đã chuẩn hóa theo tài liệu chính thức của VietQR (`api.vietqr.vn` / `api-v2.vietqr.vn`) và các quyết định nghiệp vụ, bảo mật, Prisma schema đã chốt.  
> **Trạng thái hiện tại:** Đã hoàn thành triển khai source code, database migration, unit/integration tests và tài liệu vận hành cho **Phase 1–6**. Chưa tuyên bố hoàn tất tích hợp thực tế do còn chờ credentials UAT/Production từ VietQR Tingo để kiểm thử E2E thực tế.

---

## 1. Hiện trạng Source Code & Database

### 1.1. Tech Stack đang sử dụng

| Thành phần | Công nghệ / Phiên bản | Ghi chú |
|---|---|---|
| Runtime & Language | Node.js v22, TypeScript `~5.9.0` (`strict: true`, ESM `NodeNext`, `"type": "module"`) | Import nội bộ dùng đuôi `.js` |
| Backend Framework | NestJS `^11.2.11` (`@nestjs/platform-express`), `@nestjs/config` `^4.0.4` | Bật `ConfigModule.forRoot({ isGlobal: true })` từ Phase 3 |
| Database & ORM | PostgreSQL (Neon DB), Prisma `^7.10.1` + `@prisma/adapter-pg` | Client generate vào `src/generated/prisma` (Git-ignored) |
| JWT | `jsonwebtoken` + `@types/jsonwebtoken` | Thư viện đã kiểm chứng, đúng mẫu NodeJS chính thức của VietQR (`HS512`) |
| QR Image Render | `qrcode` + `@types/qrcode` (Phase 5) | Render chuỗi `qrCode` EMVCo từ VietQR thành PNG Buffer gửi Telegram |
| Telegram Bot | Telegraf `^4.16.3` | Long polling trong `TelegramService` |
| Testing | Node.js built-in test runner (`node --test`) | Chạy trực tiếp trên `dist` / TypeScript build, không thêm framework nặng |

### 1.2. Database Schema thực tế trên Neon PostgreSQL

Database hiện tại đã có **8 bảng** (`AdminAccount`, `users`, `products`, `plans`, `orders`, `payments`, `subscriptions`, `support_tickets`) và **8 PostgreSQL ENUMs** (`language_code`, `order_status`, `payment_provider`, `payment_status`, `subscription_status`, `ticket_category`, `ticket_status`, `user_role`), với 1 Prisma migration đã áp dụng (`20261123151000_add_admin_account`).

### 1.3. Những thành phần tái sử dụng

- `PrismaModule` / `PrismaService`: kết nối PostgreSQL, `$transaction`, typed Prisma Client queries và `$queryRaw` cho row-level locking (`SELECT ... FOR UPDATE`).
- Các bảng nghiệp vụ hiện hữu (`users`, `products`, `plans`, `orders`, `payments`, `subscriptions`), bao gồm `UNIQUE (provider, provider_transaction_id)` trên `payments`, `UNIQUE (order_id)` trên `subscriptions` và `CHECK (stock_quantity >= 0)` trên `plans`.
- `ProductsModule` / `ProductsController`: tách thành `ProductsService` dùng Prisma typed queries, tái sử dụng cho cả HTTP API, `OrdersService` và `TelegramModule`.
- `TelegramModule` / `TelegramService` & `telegram-catalog.ts`: giữ nguyên cấu trúc menu song ngữ `vi`/`en` và custom emoji map.

---

## 2. API Contract chính thức của VietQR (Đã đối chiếu verbatim)

Nguồn tài liệu chính thức đã đọc trực tiếp:
- `https://api.vietqr.vn/vi/api-vietqr-callback/api-get-token`
- `https://api.vietqr.vn/vi/api-vietqr-callback/api-transaction-sync`
- `https://api.vietqr.vn/vi/api-vietqr-callback/goi-api-get-token`
- `https://api.vietqr.vn/vi/api-vietqr-callback/goi-api-generate-vietqr-code`
- `https://api.vietqr.vn/vi/api-vietqr-callback/goi-api-test-callback`
- `https://api.vietqr.vn/vi/api-vietqr-callback/retry-giao-dich`
- `https://api-v2.vietqr.vn/api-vietqr-callback`

### 2.1. Phân biệt rõ Endpoint Inbound (Merchant) vs Endpoint Outbound (VietQR)

| Chiều gọi | Endpoint | Môi trường | Mục đích |
|---|---|---|---|
| **Inbound** (VietQR -> Backend ta) | `POST /vqr/api/token_generate` | UAT & Production | Cấp Bearer JWT (`HS512`, `expires_in = 300`) cho VietQR qua Basic Auth |
| **Inbound** (VietQR -> Backend ta) | `POST /vqr/bank/api/transaction-sync` | UAT & Production *(mặc định)* | Nhận callback biến động số dư / đồng bộ giao dịch từ VietQR |
| **Outbound** (Backend ta -> VietQR) | `POST ${VIETQR_BASE_URL}/vqr/api/token_generate` | UAT: `https://dev.vietqr.org`<br>Prod: `https://api.vietqr.org` | Lấy system Bearer token từ VietQR bằng `VIETQR_SYSTEM_USERNAME`/`PASSWORD` |
| **Outbound** (Backend ta -> VietQR) | `POST ${VIETQR_BASE_URL}/vqr/api/qr/generate-customer` | UAT & Production | Tạo mã VietQR thanh toán (`qrType = 0` cho QR động, nếu tài khoản được cấp quyền) |
| **Outbound Test** (Merchant -> VietQR Sandbox) | `POST https://dev.vietqr.org/vqr/bank/api/test/transaction-callback` | **Chỉ UAT/Sandbox** | Giả lập giao dịch phía VietQR để VietQR bắn callback về `/vqr/bank/api/transaction-sync` của ta. **Không mở trên Production và không bao giờ cho giao dịch giả lập UAT xác nhận đơn Production.** |

### 2.2. Inbound 1: `POST /vqr/api/token_generate`

- **Headers:**
  - `Authorization: Basic Base64[username:password]` (so sánh constant-time bằng `timingSafeEqual` với `VIETQR_CLIENT_USERNAME` / `VIETQR_CLIENT_PASSWORD`)
  - `Content-Type: application/json` (chấp nhận body rỗng)
- **Success Response (`200 OK`):**
  ```json
  {
    "access_token": "<JWT_HS512>",
    "token_type": "Bearer",
    "expires_in": 300
  }
  ```
- **Failure Responses (đúng format `status: "FAILED"` theo bảng spec VietQR):**
  - Thiếu hoặc sai định dạng header `Authorization: Basic ...` (`400 Bad Request`):
    ```json
    {
      "status": "FAILED",
      "message": "Authorization header is missing or invalid"
    }
    ```
  - Sai thông tin `username`/`password` (`401 Unauthorized`):
    ```json
    {
      "status": "FAILED",
      "message": "Invalid credentials"
    }
    ```

### 2.3. Inbound 2: `POST /vqr/bank/api/transaction-sync`

- **Headers:**
  - `Authorization: Bearer <access_token>` (xác thực qua `jsonwebtoken.verify` với `algorithms: ['HS512']`, `clockTolerance: 0`)
  - `Content-Type: application/json`
- **Request Body (đúng tên trường trong bảng tài liệu chính thức):**
  - `bankaccount` (`string`, required)
  - `amount` (`number | string` integer -> parse sang `BigInt`, **không dùng float**, required)
  - `transType` (`"C" | "D"`, required)
  - `content` (`string`, required)
  - `transactionid` (`string`, required)
  - `transactiontime` (`number` Unix timestamp ms, VD: `1757342061000`, required — dùng làm thời điểm giao dịch ngân hàng thực tế)
  - `referencenumber` (`string`, required)
  - `orderId` (`string`, required)
  - Optional: `terminalCode`, `subTerminalCode`, `serviceCode`, `urlLink`, `sign`
  - **Lưu ý trường `sign`:** Hiện tài liệu công khai khai báo là optional; **không tự suy đoán thuật toán xác minh `sign`**. Lưu nhận biết vào `raw_payload` và chỉ kích hoạt verify khi VietQR xác nhận rõ thuật toán trước Go-Live.
- **Response (đúng contract tài liệu chính thức):**
  - **Thành công / Idempotent replay / Đã ghi nhận giao dịch bất thường để admin xử lý (`200 OK`):**
    ```json
    {
      "error": false,
      "errorReason": null,
      "toastMessage": "Transaction processed successfully",
      "object": {
        "reftransactionid": "<payment_id_in_db>"
      }
    }
    ```
  - **Thiếu / sai header Authorization (`401 Unauthorized`):**
    ```json
    {
      "error": true,
      "errorReason": "INVALID_AUTH_HEADER",
      "toastMessage": "Authorization header is missing or invalid",
      "object": null
    }
    ```
  - **Token sai / hết hạn (`401 Unauthorized`):**
    ```json
    {
      "error": true,
      "errorReason": "INVALID_TOKEN",
      "toastMessage": "Invalid or expired token",
      "object": null
    }
    ```
  - **Payload thiếu / sai kiểu dữ liệu (`400 Bad Request`):**
    ```json
    {
      "error": true,
      "errorReason": "INVALID_PAYLOAD",
      "toastMessage": "...",
      "object": null
    }
    ```
  - **Lỗi hệ thống / DB tạm thời (`500 Internal Server Error` để kích hoạt cơ chế Retry 10 lần/5 phút của VietQR):**
    ```json
    {
      "error": true,
      "errorReason": "TRANSACTION_FAILED",
      "toastMessage": "Internal processing error",
      "object": null
    }
    ```

### 2.4. Outbound: Tạo mã VietQR động (`generate-customer`)

1. Lấy system token từ `POST ${VIETQR_BASE_URL}/vqr/api/token_generate` (Basic Auth: `VIETQR_SYSTEM_USERNAME`/`VIETQR_SYSTEM_PASSWORD`), cache trong RAM theo `expires_in` (trừ safety margin 30s).
2. Gọi `POST ${VIETQR_BASE_URL}/vqr/api/qr/generate-customer` với:
   - `bankCode`: `VIETQR_BANK_CODE`
   - `bankAccount`: `VIETQR_BANK_ACCOUNT`
   - `userBankName`: `VIETQR_ACCOUNT_NAME`
   - `amount`: `order.totalAmount` (số nguyên `BigInt` -> `Number`/chuỗi nguyên an toàn, không float)
   - `content`: mã nội dung `<= 23` ký tự chữ-số không dấu (khớp `order.orderCode`)
   - `orderId`: `order.orderCode` (`<= 13` ký tự chữ-số không dấu, VD: `GS` + 10 ký tự base36/alphanumeric)
   - `qrType`: cấu hình qua `VIETQR_QR_TYPE` (mặc định `0` cho VietQR động)
   - `transType`: `"C"`
3. Lưu `qrCode`, `qrLink`, `vaAccount` (nếu có cho luồng MB/BIDV VA), `transactionRefId` vào `orders` và render `qrCode` thành ảnh PNG gửi khách qua Telegram.

---

## 3. Nghiệp vụ Đặt hàng, Tồn kho, Thanh toán & Admin Fulfillment

### 3.1. Luồng nghiệp vụ đã thống nhất (Giai đoạn hiện tại)

1. Khách chọn sản phẩm -> chọn gói dịch vụ trên Telegram.
2. Nếu gói có `requires_email = true`, bot yêu cầu khách nhập `target_email` (validate email) trước khi tạo đơn.
3. Trong một DB transaction:
   - Giữ tồn kho nguyên tử (atomic reservation): `UPDATE public.plans SET stock_quantity = stock_quantity - 1 WHERE id = $1 AND is_active = TRUE AND stock_quantity > 0` (kết hợp `CHECK (stock_quantity >= 0)` -> **chống overselling tuyệt đối** khi nhiều người đặt cùng lúc).
   - Tạo đơn `orders` với `status = 'PENDING'`, `stock_reserved = true`, `expires_at = now() + 30 minutes`, lưu `plan_snapshot`.
4. Gọi VietQR API tạo mã QR động; nếu gọi API tạo QR thất bại -> hủy đơn và giải phóng tồn kho ngay trong transaction.
5. Gửi ảnh QR + thông tin chuyển khoản + hạn thanh toán (30 phút) cho khách.
6. Khách chuyển khoản -> VietQR gửi `POST /vqr/bank/api/transaction-sync`.
7. Backend xác thực Bearer JWT -> chạy `PaymentReconciliationService` trong DB transaction:
   - Kiểm tra idempotency theo `UNIQUE (provider, provider_transaction_id)`.
   - Khóa dòng đơn hàng bằng `SELECT ... FROM public.orders WHERE order_code = $1 FOR UPDATE`.
   - Kiểm tra tài khoản nhận (`bankaccount` khớp `VIETQR_BANK_ACCOUNT` hoặc `order.payment_va_account`), `transType === 'C'`, số tiền chính xác bằng `BigInt` (`amount === order.total_amount`), trạng thái đơn và **thời điểm giao dịch ngân hàng thực tế (`transactiontime`)** so với `order.expires_at`.
   - **Đơn `PENDING` & chuyển khoản trong hạn (`transactionAt <= order.expires_at`):**
     - Ghi `payments` (`status = 'VERIFIED'`, `verified_at = now()`, `transaction_at = new Date(transactiontime)`, `received_at = now()`).
     - Cập nhật `orders` (`status = 'PAID'`, `paid_at = transactionAt`). **KHÔNG** tự chuyển `COMPLETED` và **KHÔNG** tự tạo `subscriptions`!
     - Ghi vào bảng outbox `telegram_notifications` 2 thông báo: (1) báo khách thanh toán thành công, (2) báo Admin (`TELEGRAM_ADMIN_CHAT_ID`) có đơn mới đã thanh toán.
   - **Webhook đến muộn nhưng khách chuyển khoản ĐÚNG HẠN (`order.status = 'EXPIRED'` và `transactionAt <= order.expires_at`):**
     - Thử giữ lại tồn kho nguyên tử (`stock_quantity = stock_quantity - 1 WHERE stock_quantity > 0`).
     - Nếu còn hàng -> giữ kho lại (`stock_released_at = NULL`), ghi `payments` = `VERIFIED`, cập nhật `orders` = `PAID`, enqueue thông báo khách + Admin.
     - Nếu **đã hết hàng** -> **vẫn ghi nhận giao dịch nhận tiền** vào `payments` (`status = 'REJECTED'`, `failure_reason = 'OUT_OF_STOCK_AFTER_LATE_WEBHOOK'`, `order_id = order.id`, `raw_payload`), giữ nguyên trạng thái đơn hoặc ghi chú để Admin xử lý thủ công (bổ sung kho hoặc hoàn tiền), enqueue cảnh báo khẩn cho Admin.
   - **Các trường hợp bất thường khác** (thiếu tiền, thừa tiền, sai nội dung, không tìm thấy đơn, đơn đã hủy, đơn đã thanh toán, chuyển khoản sau `expires_at`, sai STK):
     - Ghi đầy đủ vào `payments` (`UNMATCHED` hoặc `REJECTED` kèm `failure_reason` rõ ràng và `raw_payload` đã loại bỏ secret).
     - **Lưu ý ngữ nghĩa:** `REJECTED` chỉ mang nghĩa giao dịch chưa được chấp nhận để tự động xác nhận đơn, **không có nghĩa đã hoàn tiền**.
     - Enqueue cảnh báo cho Admin qua `telegram_notifications`.
8. **Sau khi DB transaction commit**, outbox worker gửi thông báo Telegram bất đồng bộ với exponential backoff; nếu backend restart hoặc Telegram API lỗi, bản ghi `PENDING` trong `telegram_notifications` tự động retry mà không bao giờ mất thông báo hay rollback thanh toán.
9. **Quy trình xử lý của Admin (endpoint Admin hoặc thao tác quản trị):**
   - Admin tiếp nhận đơn `PAID` -> chuyển sang `PROCESSING`.
   - Khi kích hoạt/giao sản phẩm xong -> Admin chuyển sang `COMPLETED` (`completed_at = now()`); nếu gói là dịch vụ đăng ký theo thời hạn (`duration_days > 0`), tạo bản ghi `subscriptions` (`status = 'ACTIVE'`, `activated_at = now()`, `expires_at = now() + duration_days`) với ràng buộc `UNIQUE (order_id)` chống tạo trùng.
10. **Giải phóng tồn kho khi hết hạn / hủy:**
    - Background sweeper chạy định kỳ tìm các đơn `PENDING` đã quá `expires_at` (cộng grace buffer ngắn, VD: 2 phút), khóa `SELECT ... FOR UPDATE SKIP LOCKED`, kiểm tra `stock_reserved = true AND stock_released_at IS NULL`, chuyển `status = 'EXPIRED'`, đặt `stock_released_at = now()` và hoàn `+1` vào `plans.stock_quantity`.
    - Khách bấm "Hủy đơn" khi đang `PENDING`: tương tự, khóa dòng, chuyển `CANCELLED`, đặt `cancelled_at = now()`, `stock_released_at = now()`, hoàn `+1` vào `plans.stock_quantity`.

---

## 4. Đồng bộ Prisma Schema & Migration an toàn (Phase 3 -> Phase 4)

### 4.1. Chiến lược đồng bộ Prisma Schema (Không phá hủy)
1. Dùng `prisma db pull --print` (chỉ đọc) để đối chiếu chính xác toàn bộ 8 bảng, 8 enum, relations, indexes, partial indexes hiện hữu trên Neon DB.
2. Cập nhật `prisma/schema.prisma` với đầy đủ models PascalCase (`AdminAccount`, `User`, `Product`, `Plan`, `Order`, `Payment`, `Subscription`, `SupportTicket`) sử dụng `@map` và `@@map` khớp 100% tên bảng/cột PostgreSQL hiện tại, bật `previewFeatures = ["partialIndexes"]`.
3. Xác minh bằng `prisma migrate diff` rằng **không có bất kỳ lệnh DROP / ALTER phá hủy nào** đối với dữ liệu và bảng hiện có.
4. Chuẩn bị **1 file SQL migration bổ sung (additive-only)** cho Neon DB và **chỉ áp dụng sau khi bạn kiểm tra và xác nhận SQL diff**:
   - `ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'VIETQR';`
   - `ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS requires_email BOOLEAN NOT NULL DEFAULT FALSE;`
   - `ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS ...` (`payment_provider`, `payment_content`, `payment_qr_code`, `payment_qr_link`, `payment_va_account`, `payment_provider_ref`, `stock_reserved`, `stock_released_at`) + partial index `orders_pending_expires_idx`.
   - `ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS ...` (`bank_account`, `trans_type`, `raw_payload`, `received_at`) + partial unique index `payments_order_verified_unique_idx`.
   - `CREATE TABLE IF NOT EXISTS public.telegram_notifications (...)` + partial index `telegram_notifications_pending_idx`.

---

## 5. Danh sách file cần tạo / chỉnh sửa theo Phase

### Phase 3 (Get Token API, Config, Prisma Schema Sync & Migration Diff)
- **Tạo mới:**
  - `src/config/vietqr.config.ts`
  - `src/payments/payments.module.ts`
  - `src/payments/vietqr/vietqr.constants.ts`
  - `src/payments/vietqr/vietqr.types.ts`
  - `src/payments/vietqr/vietqr-token.service.ts`
  - `src/payments/vietqr/vietqr-basic-auth.guard.ts`
  - `src/payments/vietqr/vietqr.controller.ts`
  - `prisma/migrations/<timestamp>_add_vietqr_payment_support/migration.sql` *(chỉ tạo file diff, chưa apply lên Neon DB trước khi bạn xác nhận)*
  - `test/vietqr-token.spec.ts`
- **Chỉnh sửa:**
  - `prisma/schema.prisma` (sync đầy đủ bảng hiện có theo introspection)
  - `.env.example` (bổ sung biến `VIETQR_*`, `TELEGRAM_ADMIN_CHAT_ID`, `ORDER_EXPIRES_MINUTES`)
  - `src/app.module.ts` (đăng ký `ConfigModule.forRoot({ isGlobal: true })` và `PaymentsModule`)
  - `package.json` (thêm `jsonwebtoken`, `@types/jsonwebtoken`, scripts `typecheck`, `test`)

### Phase 4 (Transaction Sync Callback, Core Reconciliation, Stock Reservation & Outbox)
- **Tạo mới:**
  - `src/payments/payment-provider.interface.ts`
  - `src/payments/payment-reconciliation.service.ts`
  - `src/payments/vietqr/vietqr-bearer-auth.guard.ts`
  - `src/payments/vietqr/vietqr-webhook.service.ts`
  - `src/notifications/notifications.module.ts`
  - `src/notifications/telegram-outbox.service.ts`
  - `src/orders/orders.module.ts`
  - `src/orders/orders.service.ts`
  - `src/orders/order-expiration.service.ts`
  - `src/admin/admin-orders.controller.ts` (chuyển `PAID -> PROCESSING -> COMPLETED` + tạo `subscriptions` khi hoàn tất)
  - `test/vietqr-callback.spec.ts`, `test/payment-reconciliation.spec.ts`
- **Chỉnh sửa:**
  - `prisma/schema.prisma` (cập nhật thêm cột/bảng mới sau khi migration được xác nhận & áp dụng)
  - `src/payments/vietqr/vietqr.controller.ts` (bổ sung `POST /vqr/bank/api/transaction-sync`)
  - `src/payments/payments.module.ts`, `src/admin/admin.module.ts`, `src/app.module.ts`

### Phase 5 (Tạo mã QR Outbound & Luồng đặt hàng Telegram Bot)
- **Tạo mới:**
  - `src/users/users.module.ts`, `src/users/users.service.ts`
  - `src/payments/vietqr/vietqr-api.client.ts` (gọi `token_generate` + `qr/generate-customer` + render PNG QR)
  - `src/products/products.service.ts`
- **Chỉnh sửa:**
  - `src/products/products.module.ts`, `src/products/products.controller.ts`
  - `src/telegram/telegram.module.ts`, `src/telegram/telegram.service.ts`, `src/telegram/telegram-catalog.ts`
  - `src/notifications/telegram-outbox.service.ts` (kết nối sender thật với `TelegramService`)
  - `package.json` (thêm `qrcode`, `@types/qrcode`)

### Phase 6 (Testing tổng thể, Security Review & Documentation)
- **Tạo mới:**
  - `test/order-stock-reservation.spec.ts`
  - `test/telegram-outbox.spec.ts`
  - `docs/VIETQR_INTEGRATION.md`
- **Kiểm tra:** `npm run build`, `npm run typecheck`, `npm test`, security review (không lộ secrets/token trong log, tách biệt UAT/Production, không dùng float tính tiền).

---

## 6. Biến môi trường chuẩn (`.env.example`)

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require&channel_binding=require"
PORT=3000
TELEGRAM_BOT_TOKEN=
TELEGRAM_EMOJI_OWNER_ID=
TELEGRAM_ADMIN_CHAT_ID=

# VietQR API Service
VIETQR_ENABLED=false
VIETQR_ENV=uat
VIETQR_MERCHANT_NAME=

# Inbound Auth (VietQR -> Backend của bạn)
VIETQR_CLIENT_USERNAME=
VIETQR_CLIENT_PASSWORD=
VIETQR_TOKEN_SECRET=
VIETQR_TOKEN_EXPIRES_IN=300

# Outbound API (Backend của bạn -> VietQR để sinh mã QR)
VIETQR_BASE_URL=https://dev.vietqr.org
VIETQR_SYSTEM_USERNAME=
VIETQR_SYSTEM_PASSWORD=
VIETQR_QR_TYPE=0

# Tài khoản ngân hàng nhận tiền (tạo QR & đối soát callback)
VIETQR_BANK_CODE=
VIETQR_BANK_ACCOUNT=
VIETQR_ACCOUNT_NAME=
VIETQR_TERMINAL_CODE=

# Order settings
ORDER_EXPIRES_MINUTES=30
```

---

## 7. Blocker & Giới hạn cần lưu ý trước Go-Live

1. **Credentials thực tế từ VietQR Tingo:** Các giá trị `VIETQR_SYSTEM_USERNAME`, `VIETQR_SYSTEM_PASSWORD`, `VIETQR_BANK_CODE`, `VIETQR_BANK_ACCOUNT`, `VIETQR_ACCOUNT_NAME` sẽ do chủ hệ thống cung cấp sau khi hoàn tất đăng ký API Service. Trước khi có credentials và kiểm thử E2E trên UAT/Sandbox (`dev.vietqr.org`), **không tuyên bố hoàn tất tích hợp thực tế**.
2. **Trường `sign` (optional):** Chưa xác minh thuật toán do tài liệu công khai để optional; cần xác nhận lại với VietQR trước Go-Live xem có yêu cầu chữ ký bổ sung hay không.
3. **Đường dẫn tương thích UAT:** Mặc định triển khai đúng chuẩn `POST /vqr/bank/api/transaction-sync`. Chỉ mở route alias UAT nếu VietQR Tingo thực sự yêu cầu, và tuyệt đối khóa không cho chạy khi `VIETQR_ENV=production`.
4. **Migration Neon DB:** Cần bạn xác nhận SQL diff trước khi áp dụng migration lên Neon DB.

---

## 8. Checklist triển khai theo từng Phase

### Phase 1: Audit source code & Nghiên cứu tài liệu VietQR *(Hoàn thành)*
- [x] Phân tích toàn bộ source code hiện tại và kiểm tra schema thực tế trên Neon DB.
- [x] Đọc trực tiếp tài liệu chính thức từ `api.vietqr.vn` (`api-get-token`, `api-transaction-sync`, `goi-api-get-token`, `goi-api-generate-vietqr-code`, `goi-api-test-callback`, `retry-giao-dich`) và `api-v2.vietqr.vn`.

### Phase 2: Thiết kế giải pháp & API Contract *(Hoàn thành)*
- [x] Chốt API contract, nghiệp vụ đặt hàng/giữ tồn kho/Admin fulfillment, outbox retry Telegram, bảo mật và chiến lược đồng bộ Prisma Schema.
- [x] Cập nhật hoàn chỉnh `docs/VIETQR_INTEGRATION_PLAN.md`.

### Phase 3: Triển khai Get Token API, Config & Prisma Schema Sync *(Hoàn thành)*
- [x] Đồng bộ đầy đủ 8 bảng & 8 enum hiện có vào `prisma/schema.prisma` qua introspection, xác minh không drift phá hủy (`prisma migrate diff` ra empty migration).
- [x] Chuẩn bị và kiểm tra an toàn SQL migration bổ sung `prisma/migrations/20261123163000_add_vietqr_payment_support/migration.sql` (bao gồm trạng thái `PROCESSING` và các cột lock cho Transactional Outbox).
- [x] Cài đặt `jsonwebtoken` + `@types/jsonwebtoken`, bổ sung scripts `typecheck` & `test`.
- [x] Bật `ConfigModule`, tạo `src/config/vietqr.config.ts` (tách biệt UAT/Prod) và cập nhật `.env.example`.
- [x] Triển khai `VietqrTokenService`, `VietqrBasicAuthGuard`, `POST /vqr/api/token_generate`.
- [x] Viết và chạy tests cho Phase 3 + `npm run build` + `npm run typecheck`.

### Phase 4: Triển khai Transaction Sync Callback & Core Reconciliation *(Hoàn thành)*
- [x] Kiểm tra an toàn trước migration (`prisma migrate status`, kiểm tra duplicate payments, CHECK constraints, partial indexes), áp dụng migration `20261123163000_add_vietqr_payment_support`, đồng bộ `prisma/schema.prisma` và xác minh zero schema drift (`prisma migrate diff` trống).
- [x] Triển khai `VietqrBearerAuthGuard`, `POST /vqr/bank/api/transaction-sync`, `PaymentReconciliationService` (idempotency, `SELECT FOR UPDATE`, `BigInt`, phân biệt `transaction_at` vs `received_at`, late webhook re-reserve stock, lưu `UNMATCHED`/`REJECTED`, sanitize `raw_payload`).
- [x] Triển khai `OrdersService` (giữ/nhả tồn kho nguyên tử chống overselling), `OrderExpirationService` (sweeper định kỳ + khôi phục khi restart), `TelegramOutboxService` (`PENDING/PROCESSING/SENT/FAILED`, `FOR UPDATE SKIP LOCKED`, crash recovery, `retry_after`, exponential backoff, at-least-once delivery), `AdminOrdersController` (`PAID -> PROCESSING -> COMPLETED` + tạo `subscriptions` idempotent tính từ thời điểm kích hoạt).
- [x] Viết và chạy tests HTTP + DB PostgreSQL thực tế cho Phase 4 (`23/23` pass).

### Phase 5: Tích hợp luồng thanh toán & Telegram Bot *(Hoàn thành phần nền tảng — chờ credentials thật để test E2E)*
- [x] Tách `ProductsService` dùng Prisma Client typed queries, tạo `UsersService`, cập nhật `scripts/sync-product-emojis.mjs`.
- [x] Triển khai `VietqrApiClient` (gọi `token_generate` + cache token + retry 401 + `qr/generate-customer` + render PNG QR, không hardcode/mock).
- [x] Hoàn thiện luồng Telegram Bot: chọn sản phẩm -> chọn gói -> hỏi `target_email` nếu `requires_email = true` -> tạo đơn `PENDING` giữ kho -> gửi ảnh QR -> hủy đơn / xem lịch sử đơn -> kết nối `TelegramOutboxService` sender (xử lý 429 `retry_after` & lỗi permanent 403/400).
- [x] Chạy build, typecheck và tests cho Phase 5 (`26/26` pass).

### Phase 6: Testing tổng thể, Security Review & Documentation *(Hoàn thành phần nền tảng — chờ E2E thực tế với VietQR)*
- [x] Hoàn thiện bộ test bao phủ đầy đủ kịch bản (Get Token, Callback hợp lệ/lỗi, duplicate, concurrent, sai tiền, không khớp đơn, giữ/nhả kho chống overselling, rollback khi lỗi DB / lỗi tạo QR, crash recovery outbox & `retry_after`).
- [x] Security review (không hardcode secret, không log password/JWT/Authorization, không dùng float tính tiền, cô lập UAT/Production, không gọi Telegram trong DB transaction).
- [x] Viết tài liệu vận hành `docs/VIETQR_INTEGRATION.md` đầy đủ kèm Sequence Diagram, cURL/Postman, bảng khai báo VietQR Tingo và hướng dẫn Go-Live.
- [ ] **Chờ blocker bên ngoài:** Điền credentials UAT/Production thật từ VietQR Tingo, xác minh yêu cầu trường `sign` (nếu có) và thực hiện kiểm thử E2E trên `dev.vietqr.org` trước khi Go-Live.
