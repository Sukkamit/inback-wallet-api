# ระบบติดตามออเดอร์ (Order Tracking API) และการจัดการเคสปัญหา
> **Technical Test Solution: Back-End Developer**  
> Game Top-up Order Tracking, Concurrency Control, Self-Healing & Issue Management System

---

## สารบัญ (Table of Contents)
1. [ภาพรวมระบบ (Overview)](#1-ภาพรวมระบบ-overview)
2. [สถาปัตยกรรมและเทคโนโลยี (Architecture & Tech Stack)](#2-สถาปัตยกรรมและเทคโนโลยี-architecture--tech-stack)
3. [Order State Machine & Schema](#3-order-state-machine--schema)
4. [การแก้เคสปัญหา 5 ข้อ (Solutions for 5 Problem Cases)](#4-การแก้เคสปัญหา-5-ข้อ-solutions-for-5-problem-cases)
5. [รายละเอียด API Endpoints](#5-รายละเอียด-api-endpoints)
6. [การจัดการ Error และ Logging](#6-การจัดการ-error-และ-logging)
7. [วิธีการติดตั้งและรันระบบ (Setup & Running)](#7-วิธีการติดตั้งและรันระบบ-setup--running)
8. [การทดสอบ (Testing & Verification)](#8-การทดสอบ-testing--verification)

---

## 1. ภาพรวมระบบ (Overview)

ระบบ **Order Tracking API** ออกแบบสำหรับร้านรับเติมเกมอัตโนมัติ โดยเมื่อลูกค้าสั่งซื้อ ระบบจะส่งต่องานให้ Bot ทำการจ่ายเงินและเติมเกมให้อัตโนมัติ โดยมีคุณสมบัติดังนี้:
- **Real-time Tracking**: ติดตามสถานะออเดอร์ในทุกขั้นตอนอย่างละเอียด พร้อมประวัติการเปลี่ยนสถานะ (Timeline Audit Log)
- **Self-Healing & Fault Tolerance**: ตรวจจับความผิดปกติของ Bot ได้เอง (Bot crash, timeout, provider down) และกู้คืนสถานะอัตโนมัติ
- **Concurrency & Idempotency**: ป้องกัน Race Condition และการจ่ายเงินซ้ำเมื่อมี Bot หลายตัวทำงานพร้อมกัน
- **Automated Lifecycle Management**: ระบบ Scheduler เบื้องหลังที่ทำงานอย่างปลอดภัย (Idempotent) เพื่อจัดการออเดอร์หมดอายุและตรวจสอบ SLA

---

## 2. สถาปัตยกรรมและเทคโนโลยี (Architecture & Tech Stack)

### Tech Stack
- **Language & Runtime**: Node.js v22 (LTS) / TypeScript 5.7
- **Framework**: Express.js (Clean Layered Architecture)
- **Database**: PostgreSQL 16 (พร้อม Connection Pooling, Row-Level Locks และ ACID Transactions)
- **Data Validation**: Zod Schema Validation
- **Logging**: Winston (Structured JSON Logger พร้อม Order Tracking Context & Correlation ID)
- **Containerization**: Docker & Docker Compose (Single-command startup)
- **Testing**: Jest, Supertest, pg-mem (In-memory PostgreSQL test suite 100% pass)

### สถาปัตยกรรมแบบ Layered Architecture
```
src/
├── config/             # ค่า Config และ Environment Variables
├── controllers/        # Request handling, validation, response format
│   ├── orderController.ts
│   ├── botController.ts
│   ├── webhookController.ts
│   └── adminController.ts
├── domain/             # Domain Types, State Machine, App Errors
│   ├── types.ts
│   ├── stateMachine.ts
│   └── errors.ts
├── repositories/       # Database queries & transactions (Row-level locks)
│   ├── orderRepository.ts
│   ├── timelineRepository.ts
│   ├── issueRepository.ts
│   ├── idempotencyRepository.ts
│   └── webhookRepository.ts
├── services/           # Business Logic & Recovery workflows
│   ├── orderService.ts
│   ├── botService.ts
│   ├── webhookService.ts
│   └── recoveryService.ts
├── jobs/               # Background Cron Scheduler (Idempotent recovery)
│   └── scheduler.ts
├── middlewares/        # Idempotency, Request Logger, Error Handler
│   ├── errorHandler.ts
│   └── requestLogger.ts
├── utils/              # OrderNo validator/generator, Logger instance
└── db/                 # Connection Pool, Migrations (schema.sql)
```

---

## 3. Order State Machine & Schema

### State Machine Flow
```mermaid
stateDiagram-v2
    [*] --> PENDING_PAYMENT : Create Order
    
    PENDING_PAYMENT --> QUEUED : Bank Webhook Confirmed
    PENDING_PAYMENT --> EXPIRED : Payment Expired (>15 mins)
    PENDING_PAYMENT --> DELAYED : Customer Report Issue
    
    QUEUED --> IN_PROGRESS : Bot Atomic Claim (Lease)
    QUEUED --> DELAYED : Queue SLA Exceeded (>10 mins)
    
    IN_PROGRESS --> COMPLETED : Bot Success
    IN_PROGRESS --> QUEUED : Bot Crash / Transient Retry (< 3)
    IN_PROGRESS --> DELAYED : Retries Exceeded (>= 3)
    IN_PROGRESS --> FAILED : Permanent Error (e.g. Invalid UID)
    
    FAILED --> QUEUED : Customer Updates UID
    FAILED --> REFUNDED : Admin Refund
    
    DELAYED --> QUEUED : Admin/Manual Requeue
    DELAYED --> REFUNDED : Admin Refund
    
    EXPIRED --> REFUNDED : Late Webhook Arrived
    
    COMPLETED --> [*]
    REFUNDED --> [*]
```

### สถานะออเดอร์ (Order Statuses)
| สถานะ | ความหมาย | หมวด Tab |
|---|---|---|
| `PENDING_PAYMENT` | รอลูกค้าชำระเงิน (QR Code มีอายุ 15 นาที) | Current |
| `QUEUED` | ชำระเงินแล้ว อยู่ในคิวรอ Bot ดึงไปทำงาน | Current |
| `IN_PROGRESS` | Bot กำลังดำเนินการเติมเกม (ถือ Lease) | Current |
| `DELAYED` | ล่าช้า / รอการตรวจสอบจาก Admin หรือเกิน SLA | Current |
| `COMPLETED` | เติมเกมสำเร็จเรียบร้อย (Terminal State) | History |
| `FAILED` | เติมไม่สำเร็จถาวร (เช่น UID ผิด) | History |
| `EXPIRED` | หมดอายุเนื่องจากไม่ชำระเงินตามเวลา | History |
| `REFUNDED` | คืนเงินให้ลูกค้าเรียบร้อยแล้ว (Terminal State) | History |

---

## 4. การแก้เคสปัญหา 5 ข้อ (Solutions for 5 Problem Cases)

| # | เคสปัญหา | Solution ที่เลือก | แนวทางแก้ปัญหาและเหตุผล |
|---|---|---|---|
| **1** | **Bot จ่ายเงินไม่ทำงาน**<br>(Bot ล่ม, Cookie หมดอายุ หรือ Timeout ทำให้ออเดอร์ค้าง) | **Heartbeat + Lease Mechanism พร้อม Exponential Backoff Retry** | **วิธีแก้:**<br>1. เมื่อ Bot claim ออเดอร์ จะได้รับ Lease (ค่าเริ่มต้น 60 วินาที)<br>2. Bot ที่กำลังทำงานปกติจะต้องส่ง Heartbeat มาต่ออายุ Lease ผ่าน `POST /bots/orders/:orderNo/heartbeat`<br>3. Background Job คอยตรวจจับออเดอร์ในสถานะ `IN_PROGRESS` ที่ `lease_expires_at < NOW()`<br>4. หากพบ Bot เงียบหาย ระบบจะคืนออเดอร์เข้าสถานะ `QUEUED` พร้อมเพิ่ม `retry_count` และคำนวณ Exponential Backoff (2^n * 5 วินาที)<br>5. หากลองซ้ำเกินกำหนด (`max_retries = 3`) ระบบจะย้ายเป็น `DELAYED` ทันทีและส่ง Alert ให้ Admin<br><br>**เหตุผลที่เลือก:**<br>วิธีนี้ป้องกันออเดอร์ค้างได้ 100% โดยไม่แย่งงาน Bot ที่กำลังประมวลผลอยู่จริง และ Exponential Backoff ป้องกันไม่ให้เกิด Thundering Herd / Retry Storm ไปยัง Game Provider |
| **2** | **Bot สองตัวแย่งออเดอร์เดียวกัน**<br>(Race Condition ทำให้จ่ายเงินซ้ำ) | **Triple-Layer Concurrency Control:**<br>1. `SELECT ... FOR UPDATE SKIP LOCKED`<br>2. Optimistic Concurrency Check (`version`)<br>3. Table-Level Unique Constraint | **วิธีแก้:**<br>1. ใช้ Row Lock แบบ `SELECT * FROM orders WHERE order_no = $1 AND status = 'QUEUED' FOR UPDATE SKIP LOCKED` ในระดับฐานข้อมูล ทำให้มีเพียง Bot เดียวที่ล็อคแถวได้ Bot อื่นจะข้ามทันที<br>2. ทำการบันทึกลงตาราง `bot_executions (order_no, bot_id)` ซึ่งมี **Unique Constraint บน `order_no`** หากมีการเคลมซ้ำ PostgreSQL จะโยน 23505 Error ทันที<br>3. อัปเดตสถานะด้วย `WHERE version = $version` ป้องกัน Lost Update<br><br>**เหตุผลที่เลือก:**<br>เป็นการการันตีความปลอดภัย 3 ชั้นทั้งในระดับ Application และ Database Engine แม้ระบบจะขยายตัวเป็น Distributed Microservices หลายร้อย Node ก็ไม่มีทางเกิดการเติมเงินซ้ำแน่นอน |
| **3** | **Webhook ธนาคารมาซ้ำ หรือมาช้า / ผิดลำดับ** | **Idempotent Event Log + State Machine Guard + Late Payment Auto-Refund** | **วิธีแก้:**<br>1. ตรวจสอบ HMAC-SHA256 Signature ด้วย Secret Key ป้องกันการปลอมแปลง Request<br>2. บันทึกและตรวจสอบ `event_id` ในตาราง `webhook_events` หากเป็น Event ซ้ำ จะตอบกลับ HTTP 200 `IDEMPOTENT_IGNORED` โดยไม่ประมวลผลซ้ำ<br>3. ตรวจสอบสถานะ Order ใน Database หาก Order เปลี่ยนเป็น `QUEUED`, `IN_PROGRESS` หรือ `COMPLETED` ไปแล้ว จะไม่เปลี่ยนสถานะถอยหลัง<br>4. หาก Webhook มาช้าโดยเวลาเกิน `payment_expires_at` หรือ Order เป็น `EXPIRED` ไปแล้ว ระบบจะเปลี่ยนสถานะเป็น `REFUNDED` อัตโนมัติและบันทึกลง Timeline<br><br>**เหตุผลที่เลือก:**<br>สอดคล้องกับธรรมชาติของ Network Webhook แบบ At-least-once Delivery และป้องกันเงินของลูกค้าสูญหายกรณีจ่ายช้า |
| **4** | **เติมไม่สำเร็จ**<br>(เช่น UID ผิด หรือ Provider ล่ม) | **Failure Classification (Transient vs Permanent) + Self-Service UID Correction** | **วิธีแก้:**<br>1. แบ่ง Error ออกเป็น 2 ประเภทอย่างชัดเจน:<br>   - **PERMANENT** (เช่น UID ผิด, ไม่มีตัวละคร, บัญชีถูกแบน): ปรับเป็น `FAILED` ทันที ไม่ retry ซ้ำซ้อน และเปิด Endpoint `PATCH /orders/:orderNo/update-target` ให้ลูกค้าหรือ Admin แก้ไข UID ที่ถูกต้องได้ เมื่อแก้ไขแล้วสถานะจะกลับเป็น `QUEUED` ทันที<br>   - **TRANSIENT** (เช่น Provider 503, Network Timeout): Re-queue พร้อมนับ Retry Count และ Exponential Backoff จนครบ 3 ครั้ง หากไม่ผ่านจะย้ายเป็น `DELAYED`<br>2. ทุกเหตุผลและข้อความ Error จะถูกบันทึกใน Timeline อย่างครบถ้วน<br><br>**เหตุผลที่เลือก:**<br>การไม่ retry ข้อผิดพลาดประเภท Permanent ช่วยประหยัดค่าใช้จ่ายและ Resource ได้มหาศาล ในขณะที่เปิดโอกาสให้ลูกค้าแก้ไขข้อมูลเองได้ทันทีโดยไม่ต้องรอ Support |
| **5** | **ออเดอร์ค้าง / หมดอายุ**<br>(คิวนานเกิน SLA หรือ QR หมดเวลา) | **Periodic Idempotent Background Job Scheduler** | **วิธีแก้:**<br>1. Scheduler ทำงานเป็น Background Worker ทุกระยะเวลาที่กำหนด (เช่น ทุก 10 วินาที หรือผ่าน Cron)<br>2. ค้นหาออเดอร์ `PENDING_PAYMENT` ที่เกิน `payment_expires_at` (15 นาที) และปรับเป็น `EXPIRED`<br>3. ค้นหาออเดอร์ `QUEUED` ที่ค้างในคิวนานเกินกำหนด SLA (10 นาที) และปรับเป็น `DELAYED` พร้อมสร้าง Alert บันทึกใน Timeline<br>4. ทุกคำสั่งใน Scheduler เป็น **Idempotent** (รันซ้ำได้โดยไม่สร้างผลข้างเคียง) และใช้ Transaction พร้อม Row Lock<br><br>**เหตุผลที่เลือก:**<br>ทำงานเบื้องหลังโดยอัตโนมัติ ไม่ต้องพึ่งพา Trigger จาก Request ของผู้ใช้ ทำให้ State ของระบบถูกต้องและแม่นยำตลอดเวลา |

---

## 5. รายละเอียด API Endpoints

### 1. Order Endpoints (Part 1)
| Method | Path | หน้าที่ | Parameters / Body |
|---|---|---|---|
| `POST` | `/orders` | สร้างออเดอร์ใหม่ | Header: `Idempotency-Key`<br>Body: `customer_id`, `game_id`, `package_id`, `uid`, `amount`, `server_id` |
| `GET` | `/orders/:orderNo` | ดูข้อมูลออเดอร์เดี่ยว | Validate format `ORD-\d+-\d+`<br>(ตอบ 400 หาก format ผิด, 404 หากไม่พบ) |
| `GET` | `/orders` | รายการออเดอร์แบ่งหน้า | Query: `tab=current\|history`, `page=1`, `limit=10`<br>(เรียงจากใหม่ไปเก่า) |
| `GET` | `/orders/:orderNo/timeline` | ประวัติการเปลี่ยนสถานะ | แสดง Status, Action, Reason, Actor, Timestamp |
| `POST` | `/orders/:orderNo/report-issue` | ลูกค้าแจ้งปัญหา | Body: `reported_by`, `category`, `details`<br>(ย้ายเป็น DELAYED) |
| `PATCH`| `/orders/:orderNo/update-target` | ลูกค้าแก้ไข UID เมื่อเติมไม่สำเร็จ | Body: `uid`<br>(ย้าย FAILED/DELAYED -> QUEUED) |
| `POST` | `/orders/:orderNo/refund` | คืนเงินออเดอร์ | Body: `reason`<br>(ย้ายเป็น REFUNDED) |

### 2. Bot Endpoints (Part 2 - Cases 1, 2, 4)
| Method | Path | หน้าที่ | Parameters / Body |
|---|---|---|---|
| `POST` | `/bots/orders/:orderNo/claim` | Bot เคลมออเดอร์แบบ Atomic | Body: `bot_id`, `lease_seconds`<br>(409 หากมี Bot อื่นเคลมแล้ว) |
| `POST` | `/bots/orders/:orderNo/heartbeat` | Bot ส่ง Heartbeat ต่ออายุ Lease | Body: `bot_id`, `lease_extension_seconds` |
| `POST` | `/bots/orders/:orderNo/complete` | Bot เติมเงินสำเร็จ | Body: `bot_id`, `external_transaction_id` |
| `POST` | `/bots/orders/:orderNo/fail` | Bot แจ้งข้อผิดพลาด | Body: `bot_id`, `failure_type: "TRANSIENT"\|"PERMANENT"`, `reason` |

### 3. Webhook & System Endpoints (Part 2 - Cases 3, 5)
| Method | Path | หน้าที่ | Parameters / Body |
|---|---|---|---|
| `POST` | `/webhooks/bank` | รับ Webhook การชำระเงินจากธนาคาร | Header: `x-signature`<br>Body: `eventId`, `orderNo`, `amount`, `paymentStatus`, `transactionTime` |
| `POST` | `/admin/jobs/trigger-recovery` | Trigger Background Jobs แบบ Manual | Body: `slaMinutes` (สำหรับทดสอบ Demo) |

---

## 6. การจัดการ Error และ Logging

### Standard Error Response Format
ทุก Error ในระบบส่งกลับในรูปแบบเดียวกัน:
```json
{
  "code": "BAD_REQUEST",
  "message": "Invalid order number format: 'ORD-abc'. Expected format: ORD-<digits>-<digits>",
  "orderNo": "ORD-abc"
}
```
HTTP Status Codes ที่ใช้:
- `400 BAD_REQUEST`: ข้อมูล Request ไม่ถูกต้อง หรือ format ไม่ตรง
- `401 UNAUTHORIZED`: Webhook signature ไม่ถูกต้อง
- `404 NOT_FOUND`: ไม่พบออเดอร์ในระบบ
- `409 CONFLICT`: Bot แย่งเคลมออเดอร์ซ้ำซ้อน (Race condition)
- `422 INVALID_STATE_TRANSITION`: การเปลี่ยนสถานะผิดกฎ State Machine
- `500 INTERNAL_SERVER_ERROR`: ข้อผิดพลาดภายในระบบ

### Structured Tracing Log
ระบบใช้ Winston บันทึก Structured Log พร้อมผูก `orderNo` และ `correlationId` สำหรับ Tracing:
```
2026-10-12 11:42:16.397 [info] [Order: ORD-1791780136396-382] Creating new order {"customerId":"CUST-001","amount":150}
2026-10-12 11:42:17.676 [warn] [Order: ORD-1791780137557-227] Customer reported issue {"category":"DELAYED","details":"Top up taking longer than 10 minutes"}
```

---

## 7. วิธีการติดตั้งและรันระบบ (Setup & Running)

### วิธีที่ 1: รันด้วย Docker Compose (คำสั่งเดียว - แนะนำ)
รองรับการรันทั้ง PostgreSQL และ API Server ด้วยคำสั่งเดียว:
```bash
docker compose up --build
```
ระบบจะเริ่มต้น PostgreSQL, ทำการ Migrate Database Schema อัตโนมัติ และเปิด API บน `http://localhost:3000`

### วิธีที่ 2: รันแบบ Local Development
1. ติดตั้ง Dependencies:
```bash
npm install
```
2. ตั้งค่าไฟล์ `.env`:
```bash
cp .env.example .env
# หรือบน Windows PowerShell:
Copy-Item .env.example .env
```

### ⚙️ รายละเอียดตัวแปร Environment Variables (`.env`)
| ตัวแปร (Variable) | ค่าเริ่มต้น (Default) | คำอธิบาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตสำหรับเรียกใช้งาน RESTful API และ Web Demo |
| `NODE_ENV` | `development` | สภาพแวดล้อมการทำงาน (`development` / `production` / `test`) |
| `LOG_LEVEL` | `info` | ระดับการบันทึก Log ของ Winston (`debug`, `info`, `warn`, `error`) |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/order_tracking_db` | Connection String สำหรับเชื่อมต่อฐานข้อมูล PostgreSQL |
| `DB_POOL_MAX` | `20` | จำนวน Connection สูงสุดใน Connection Pool |
| `PAYMENT_EXPIRY_MINUTES` | `15` | ระยะเวลาหมดอายุของ QR Code ชำระเงิน (เคส 5) |
| `QUEUE_SLA_MINUTES` | `10` | เกณฑ์ SLA คิวสูงสุด หากเกินจะปรับเป็น DELAYED (เคส 5) |
| `DEFAULT_LEASE_SECONDS` | `60` | ระยะเวลาถือสิทธิ์ Lease ของ Bot ต่อออเดอร์ (เคส 1) |
| `MAX_BOT_RETRIES` | `3` | จำนวนครั้งสูงสุดที่อนุญาตให้ Bot ลองใหม่กรณีขัดข้องชั่วคราว |
| `BANK_WEBHOOK_SECRET` | `bank_webhook_secret_key` | Secret Key สำหรับตรวจสอบ HMAC-SHA256 Webhook ธนาคาร (เคส 3) |

3. รัน Migration และเริ่มเซิร์ฟเวอร์แบบ Development:
```bash
npm run dev
```
4. หรือ Build และรัน Production:
```bash
npm run build
npm start
```

---

## 8. การทดสอบ (Testing & Verification)

### 1. รัน Unit & Integration Tests (100% Pass)
ระบบมีชุดการทดสอบอัตโนมัติด้วย Jest และ In-memory Database (`pg-mem`) โดยสามารถรันได้ทันทีโดยไม่ต้องเปิด PostgreSQL ภายนอก:
```bash
npm test
```
หรือดู Code Coverage:
```bash
npm run test:coverage
```

### ผลการทดสอบ (Test Suites Summary):
```
PASS tests/unit/orderNoValidator.test.ts
PASS tests/unit/stateMachine.test.ts
PASS tests/integration/ordersApi.test.ts
PASS tests/integration/problemCases.test.ts

Test Suites: 4 passed, 4 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        10.723 s
```

### 2. ทดสอบผ่าน Web Dashboard หรือ REST Client / Postman
- **🌐 Interactive Web Dashboard**: เข้าใช้งานระบบผ่านหน้าเว็บได้ทันทีที่ **[http://localhost:3000](http://localhost:3000)** (มีปุ่มสร้างออเดอร์, จำลองการโอนเงินเต็ม/จ่ายขาด, ปุ่มบอทรับงาน, ปุ่มลองใหม่ (Retry), และปุ่มคืนเงินครบวงจร)
- **VS Code REST Client**: เปิดไฟล์ [`orders.http`](file:///c:/Project/inback/orders.http) แล้วกด `Send Request` เพื่อทดสอบตามลำดับ
- **Postman**: นำเข้าไฟล์ [`postman_collection.json`](file:///c:/Project/inback/postman_collection.json) เข้าสู่ Postman แล้วสั่งรัน Collection ได้ทันที

---

## 9. ข้อมูลอ้างอิงชุดข้อสอบทั้ง 4 ส่วน (Complete Suite Map)
- **ข้อ 1 (Task A): Order Tracking API & State Machine** — `c:\Project\inback` (Port: 3000)
- **ข้อ 2 (Task B): Aniimo Reverse Engineering & UID Top-Up** — `c:\Project\aniimo-topup` (Port: 3001)
- **ข้อ 3 (Task C): Centralized Bot Monitoring & Control Center** — `c:\Project\oxide-bot-monitor` (Port: 3002)
- **ข้อ 4 (Task D): AOEM BitCash Top-Up Bot & Balance Checker** — `c:\Project\aoem-bitcash-bot` (Port: 3003)
