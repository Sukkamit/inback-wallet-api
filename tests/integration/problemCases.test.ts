import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../src/app';
import { createTestDb } from '../testDb';
import { OrderRepository } from '../../src/repositories/orderRepository';
import { RecoveryService } from '../../src/services/recoveryService';
import { OrderStatus, FailureType } from '../../src/domain/types';

describe('Problem Cases 1-5 Integration Tests', () => {
  let app: any;
  let orderRepo: OrderRepository;
  let recoveryService: RecoveryService;

  beforeAll(() => {
    createTestDb();
    app = createApp();
    orderRepo = new OrderRepository();
    recoveryService = new RecoveryService();
  });

  // Helper to create an order
  async function createTestOrder(amount: number = 100): Promise<string> {
    const res = await request(app)
      .post('/orders')
      .send({
        customer_id: 'CUST-TEST',
        game_id: 'ROV',
        package_id: 'PKG-100',
        uid: 'UID-1234',
        amount,
      });
    return res.body.data.order_no;
  }

  // ==========================================
  // CASE 1: Bot Silence, Heartbeat & Lease Recovery
  // ==========================================
  describe('Case 1: Bot Silent/Crash & Lease Expiry Recovery', () => {
    it('Bot heartbeat extends lease expiration', async () => {
      const orderNo = await createTestOrder(50);
      // Transition to QUEUED
      await orderRepo.updateStatus(orderNo, OrderStatus.QUEUED);

      // Bot claims order
      const claimRes = await request(app)
        .post(`/bots/orders/${orderNo}/claim`)
        .send({ bot_id: 'BOT-01', lease_seconds: 30 });
      expect(claimRes.status).toBe(200);

      // Send heartbeat
      const hbRes = await request(app)
        .post(`/bots/orders/${orderNo}/heartbeat`)
        .send({ bot_id: 'BOT-01', lease_extension_seconds: 120 });
      expect(hbRes.status).toBe(200);
      expect(hbRes.body.success).toBe(true);
    });

    it('Expired bot lease is detected and requeued with backoff, then DELAYED after max retries', async () => {
      const orderNo = await createTestOrder(50);
      await orderRepo.updateStatus(orderNo, OrderStatus.QUEUED);

      // Bot 1 claims order with 1 second lease
      await request(app)
        .post(`/bots/orders/${orderNo}/claim`)
        .send({ bot_id: 'BOT-CRASH', lease_seconds: 1 });

      // Simulate lease expiration by updating lease_expires_at to past
      await orderRepo.updateStatus(orderNo, OrderStatus.IN_PROGRESS, {
        lease_expires_at: new Date(Date.now() - 5000),
      });

      // Run recovery job (Retry 1)
      await recoveryService.handleExpiredBotLeases();
      let order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.QUEUED);
      expect(order?.retry_count).toBe(1);

      // Simulate bot claiming and crashing again (Retry 2)
      await orderRepo.updateStatus(orderNo, OrderStatus.IN_PROGRESS, {
        assigned_bot_id: 'BOT-CRASH-2',
        lease_expires_at: new Date(Date.now() - 5000),
      });
      await recoveryService.handleExpiredBotLeases();
      order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.QUEUED);
      expect(order?.retry_count).toBe(2);

      // Simulate bot claiming and crashing again (Retry 3)
      await orderRepo.updateStatus(orderNo, OrderStatus.IN_PROGRESS, {
        assigned_bot_id: 'BOT-CRASH-3',
        lease_expires_at: new Date(Date.now() - 5000),
      });
      await recoveryService.handleExpiredBotLeases();
      order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.QUEUED);
      expect(order?.retry_count).toBe(3);

      // 4th crash: max retries exceeded -> transitions to DELAYED and alerts admin
      await orderRepo.updateStatus(orderNo, OrderStatus.IN_PROGRESS, {
        assigned_bot_id: 'BOT-CRASH-4',
        lease_expires_at: new Date(Date.now() - 5000),
      });
      await recoveryService.handleExpiredBotLeases();
      order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.DELAYED);

      // Check timeline has LEASE_EXPIRED_ESCALATED
      const timelineRes = await request(app).get(`/orders/${orderNo}/timeline`);
      const actions = timelineRes.body.data.map((t: any) => t.action);
      expect(actions).toContain('LEASE_EXPIRED_ESCALATED');
    });
  });

  // ==========================================
  // CASE 2: Concurrency & Race Condition Prevention
  // ==========================================
  describe('Case 2: Race Condition Prevention between Bots', () => {
    it('Only one bot can claim an order; second bot receives 409 Conflict', async () => {
      const orderNo = await createTestOrder(120);
      await orderRepo.updateStatus(orderNo, OrderStatus.QUEUED);

      // Bot 1 claims
      const res1 = await request(app)
        .post(`/bots/orders/${orderNo}/claim`)
        .send({ bot_id: 'BOT-ALPHA', lease_seconds: 60 });
      expect(res1.status).toBe(200);
      expect(res1.body.data.status).toBe('IN_PROGRESS');

      // Bot 2 tries to claim same order
      const res2 = await request(app)
        .post(`/bots/orders/${orderNo}/claim`)
        .send({ bot_id: 'BOT-BETA', lease_seconds: 60 });
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('CONFLICT');
    });
  });

  // ==========================================
  // CASE 3: Bank Webhook Concurrency, Duplicate & Late Arrival
  // ==========================================
  describe('Case 3: Bank Webhook Duplicate, Delayed, Out-of-Order Handling', () => {
    const webhookSecret = process.env.BANK_WEBHOOK_SECRET || 'bank_webhook_secret_key';

    function signPayload(payloadObj: object): string {
      const json = JSON.stringify(payloadObj);
      return crypto.createHmac('sha256', webhookSecret).update(json).digest('hex');
    }

    it('Transitions PENDING_PAYMENT to QUEUED on first successful webhook', async () => {
      const orderNo = await createTestOrder(200);

      const payload = {
        eventId: `EVT-${Date.now()}-1`,
        orderNo,
        amount: 200,
        paymentStatus: 'SUCCESS',
        transactionTime: new Date().toISOString(),
      };
      const signature = signPayload(payload);

      const res = await request(app)
        .post('/webhooks/bank')
        .set('x-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PROCESSED');

      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.QUEUED);
    });

    it('Duplicate webhook event ID returns idempotent response without double-processing', async () => {
      const orderNo = await createTestOrder(250);
      const eventId = `EVT-DUPLICATE-${Date.now()}`;

      const payload = {
        eventId,
        orderNo,
        amount: 250,
        paymentStatus: 'SUCCESS',
        transactionTime: new Date().toISOString(),
      };
      const signature = signPayload(payload);

      // First webhook
      const res1 = await request(app)
        .post('/webhooks/bank')
        .set('x-signature', signature)
        .send(payload);
      expect(res1.status).toBe(200);
      expect(res1.body.data.status).toBe('PROCESSED');

      // Second duplicate webhook with same eventId
      const res2 = await request(app)
        .post('/webhooks/bank')
        .set('x-signature', signature)
        .send(payload);
      expect(res2.status).toBe(200);
      expect(res2.body.data.status).toBe('IDEMPOTENT_IGNORED');
    });

    it('Late webhook arriving after payment expired automatically transitions to REFUNDED', async () => {
      const orderNo = await createTestOrder(350);

      // Simulate expired payment window
      await orderRepo.updateStatus(orderNo, OrderStatus.PENDING_PAYMENT, {
        payment_expires_at: new Date(Date.now() - 60000), // 1 minute ago
      });

      const payload = {
        eventId: `EVT-LATE-${Date.now()}`,
        orderNo,
        amount: 350,
        paymentStatus: 'SUCCESS',
        transactionTime: new Date().toISOString(),
      };
      const signature = signPayload(payload);

      const res = await request(app)
        .post('/webhooks/bank')
        .set('x-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('EXPIRED_REFUNDED');

      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.REFUNDED);
    });
  });

  // ==========================================
  // CASE 4: Top-up Failure (Transient vs Permanent) & Correct UID
  // ==========================================
  describe('Case 4: Top-up Failure Classification & UID Correction', () => {
    it('Permanent failure (Invalid UID) moves directly to FAILED, customer corrects UID and requeues', async () => {
      const orderNo = await createTestOrder(80);
      await orderRepo.updateStatus(orderNo, OrderStatus.QUEUED);

      // Bot claims order
      await request(app)
        .post(`/bots/orders/${orderNo}/claim`)
        .send({ bot_id: 'BOT-03', lease_seconds: 60 });

      // Bot encounters invalid UID -> reports PERMANENT failure
      const failRes = await request(app)
        .post(`/bots/orders/${orderNo}/fail`)
        .send({
          bot_id: 'BOT-03',
          failure_type: FailureType.PERMANENT,
          reason: 'Character not found for UID: UID-1234',
        });
      expect(failRes.status).toBe(200);

      let order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.FAILED);
      expect(order?.failure_type).toBe(FailureType.PERMANENT);

      // Customer corrects UID via endpoint
      const updateRes = await request(app)
        .patch(`/orders/${orderNo}/update-target`)
        .send({ uid: 'CORRECTED-UID-9999' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.status).toBe(OrderStatus.QUEUED);
      expect(updateRes.body.data.uid).toBe('CORRECTED-UID-9999');

      // Verify timeline
      const timelineRes = await request(app).get(`/orders/${orderNo}/timeline`);
      const actions = timelineRes.body.data.map((t: any) => t.action);
      expect(actions).toContain('PERMANENT_FAILURE');
      expect(actions).toContain('UID_UPDATED_REQUEUED');
    });

    it('Transient failure (Provider 503) re-queues with backoff retry', async () => {
      const orderNo = await createTestOrder(90);
      await orderRepo.updateStatus(orderNo, OrderStatus.QUEUED);

      await request(app)
        .post(`/bots/orders/${orderNo}/claim`)
        .send({ bot_id: 'BOT-04', lease_seconds: 60 });

      // Bot encounters temporary provider timeout -> reports TRANSIENT
      const failRes = await request(app)
        .post(`/bots/orders/${orderNo}/fail`)
        .send({
          bot_id: 'BOT-04',
          failure_type: FailureType.TRANSIENT,
          reason: 'Provider gateway timeout 504',
        });

      expect(failRes.status).toBe(200);
      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.QUEUED);
      expect(order?.retry_count).toBe(1);
    });
  });

  // ==========================================
  // CASE 5: Background Scheduler (Expiry & SLA Watcher)
  // ==========================================
  describe('Case 5: Stale Orders & Queue SLA Monitoring', () => {
    it('Unpaid orders past payment_expires_at transition to EXPIRED', async () => {
      const orderNo = await createTestOrder(110);
      // Set payment_expires_at to past
      await orderRepo.updateStatus(orderNo, OrderStatus.PENDING_PAYMENT, {
        payment_expires_at: new Date(Date.now() - 10000),
      });

      const expiredCount = await recoveryService.expireUnpaidOrders();
      expect(expiredCount).toBeGreaterThanOrEqual(1);

      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.EXPIRED);
    });

    it('Orders stuck in QUEUED exceeding SLA transition to DELAYED and alert admin', async () => {
      const orderNo = await createTestOrder(130);
      // Move to QUEUED with queued_at 15 minutes ago
      await orderRepo.updateStatus(orderNo, OrderStatus.QUEUED, {
        queued_at: new Date(Date.now() - 15 * 60 * 1000),
      });

      // Check SLA with 10 minute limit
      const slaViolations = await recoveryService.checkQueueSlaViolations(10);
      expect(slaViolations).toBeGreaterThanOrEqual(1);

      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order?.status).toBe(OrderStatus.DELAYED);

      // Verify timeline
      const timelineRes = await request(app).get(`/orders/${orderNo}/timeline`);
      const actions = timelineRes.body.data.map((t: any) => t.action);
      expect(actions).toContain('QUEUE_SLA_VIOLATION_DELAYED');
    });
  });
});
