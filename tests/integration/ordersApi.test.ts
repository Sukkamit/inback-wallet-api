import request from 'supertest';
import { createApp } from '../../src/app';
import { createTestDb } from '../testDb';

describe('Order Tracking API Endpoints', () => {
  let app: any;

  beforeAll(() => {
    createTestDb();
    app = createApp();
  });

  it('POST /orders should create a new order and return ORD- format', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        customer_id: 'CUST-001',
        game_id: 'ROV',
        package_id: 'PKG-500-COINS',
        uid: 'PLAYER-12345',
        server_id: 'ASIA',
        amount: 150.0,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.order_no).toMatch(/^ORD-\d+-\d+$/);
    expect(res.body.data.status).toBe('PENDING_PAYMENT');
    expect(res.body.data.amount).toBe(150.0);
  });

  it('POST /orders with Idempotency-Key should return identical response on duplicate call', async () => {
    const idempotencyKey = 'test-idempotency-key-123';
    const payload = {
      customer_id: 'CUST-002',
      game_id: 'GENSHIN',
      package_id: 'PKG-BLESSING',
      uid: 'GENSHIN-999',
      amount: 179.0,
    };

    const firstRes = await request(app)
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(firstRes.status).toBe(201);
    const orderNo = firstRes.body.data.order_no;

    // Second call with same idempotency key
    const secondRes = await request(app)
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.data.order_no).toBe(orderNo);
  });

  it('GET /orders/:orderNo should validate format and return 400 for invalid format', async () => {
    const res = await request(app).get('/orders/INVALID-FORMAT-123');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('GET /orders/:orderNo should return 404 for non-existent order with valid format', async () => {
    const res = await request(app).get('/orders/ORD-9999999999999-999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('GET /orders/:orderNo should return order details for existing order', async () => {
    const createRes = await request(app)
      .post('/orders')
      .send({
        customer_id: 'CUST-003',
        game_id: 'VALORANT',
        package_id: 'PKG-VP-1000',
        uid: 'VAL-PLAYER-1',
        amount: 300.0,
      });

    const orderNo = createRes.body.data.order_no;

    const res = await request(app).get(`/orders/${orderNo}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.order_no).toBe(orderNo);
  });

  it('GET /orders?tab=current should list active orders', async () => {
    const res = await request(app).get('/orders?tab=current&page=1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.page).toBe(1);
  });

  it('GET /orders/:orderNo/timeline should return order history', async () => {
    const createRes = await request(app)
      .post('/orders')
      .send({
        customer_id: 'CUST-004',
        game_id: 'FREE_FIRE',
        package_id: 'PKG-DIAMONDS-100',
        uid: 'FF-999',
        amount: 50.0,
      });

    const orderNo = createRes.body.data.order_no;

    const res = await request(app).get(`/orders/${orderNo}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].action).toBe('ORDER_CREATED');
  });

  it('POST /orders/:orderNo/report-issue should transition active order to DELAYED and log timeline', async () => {
    const createRes = await request(app)
      .post('/orders')
      .send({
        customer_id: 'CUST-005',
        game_id: 'PUBG_M',
        package_id: 'PKG-UC-60',
        uid: 'PUBG-1234',
        amount: 35.0,
      });

    const orderNo = createRes.body.data.order_no;

    const issueRes = await request(app)
      .post(`/orders/${orderNo}/report-issue`)
      .send({
        reported_by: 'CUST-005',
        category: 'DELAYED',
        details: 'Top up taking longer than 10 minutes',
      });

    expect(issueRes.status).toBe(200);
    expect(issueRes.body.success).toBe(true);
    expect(issueRes.body.data.order.status).toBe('DELAYED');

    // Verify timeline has ISSUE_REPORTED
    const timelineRes = await request(app).get(`/orders/${orderNo}/timeline`);
    const actions = timelineRes.body.data.map((t: any) => t.action);
    expect(actions).toContain('ISSUE_REPORTED');
  });
});
