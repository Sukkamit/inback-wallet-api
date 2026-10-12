import { PoolClient, QueryResult } from 'pg';
import { getPool, IDbExecutor } from '../db/connection';
import { Order, OrderStatus, FailureType, PaginationParams } from '../domain/types';

export class OrderRepository {
  private getExecutor(executor?: IDbExecutor): IDbExecutor {
    return executor || getPool();
  }

  public async create(order: Partial<Order>, executor?: IDbExecutor): Promise<Order> {
    const exec = this.getExecutor(executor);
    const sql = `
      INSERT INTO orders (
        order_no, customer_id, game_id, package_id, uid, server_id,
        amount, status, payment_expires_at, version, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
      RETURNING *;
    `;
    const params = [
      order.order_no,
      order.customer_id,
      order.game_id,
      order.package_id,
      order.uid,
      order.server_id || null,
      order.amount,
      order.status || OrderStatus.PENDING_PAYMENT,
      order.payment_expires_at,
      order.version || 1,
    ];

    const result = await exec.query(sql, params);
    return this.mapRowToOrder(result.rows[0]);
  }

  public async findByOrderNo(orderNo: string, executor?: IDbExecutor): Promise<Order | null> {
    const exec = this.getExecutor(executor);
    const sql = `SELECT * FROM orders WHERE order_no = $1;`;
    const result = await exec.query(sql, [orderNo]);
    if (result.rows.length === 0) return null;
    return this.mapRowToOrder(result.rows[0]);
  }

  public async findByOrderNoForUpdate(orderNo: string, client: PoolClient): Promise<Order | null> {
    const sql = `SELECT * FROM orders WHERE order_no = $1 FOR UPDATE SKIP LOCKED;`;
    const result = await client.query(sql, [orderNo]);
    if (result.rows.length === 0) return null;
    return this.mapRowToOrder(result.rows[0]);
  }

  public async findPaginated(
    params: PaginationParams,
    executor?: IDbExecutor
  ): Promise<{ data: Order[]; total: number; page: number; limit: number; totalPages: number }> {
    const exec = this.getExecutor(executor);
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(100, params.limit || 10));
    const offset = (page - 1) * limit;

    let whereClause = '';
    const queryParams: any[] = [];

    if (params.tab === 'current') {
      whereClause = `WHERE status IN ('PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'DELAYED')`;
    } else if (params.tab === 'history') {
      whereClause = `WHERE status IN ('COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED')`;
    }

    const countSql = `SELECT COUNT(*) AS total FROM orders ${whereClause};`;
    const countResult = await exec.query(countSql);
    const total = parseInt(countResult.rows[0].total, 10);

    const dataSql = `
      SELECT * FROM orders
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2;
    `;
    const dataResult = await exec.query(dataSql, [limit, offset]);
    const data = dataResult.rows.map((row) => this.mapRowToOrder(row));

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  public async updateStatus(
    orderNo: string,
    toStatus: OrderStatus,
    updates: Partial<Order> = {},
    executor?: IDbExecutor
  ): Promise<Order | null> {
    const exec = this.getExecutor(executor);
    const fields: string[] = ['status = $2', 'updated_at = NOW()', 'version = version + 1'];
    const params: any[] = [orderNo, toStatus];
    let idx = 3;

    if (updates.assigned_bot_id !== undefined) {
      fields.push(`assigned_bot_id = $${idx++}`);
      params.push(updates.assigned_bot_id);
    }
    if (updates.lease_expires_at !== undefined) {
      fields.push(`lease_expires_at = $${idx++}`);
      params.push(updates.lease_expires_at);
    }
    if (updates.retry_count !== undefined) {
      fields.push(`retry_count = $${idx++}`);
      params.push(updates.retry_count);
    }
    if (updates.last_heartbeat_at !== undefined) {
      fields.push(`last_heartbeat_at = $${idx++}`);
      params.push(updates.last_heartbeat_at);
    }
    if (updates.failure_reason !== undefined) {
      fields.push(`failure_reason = $${idx++}`);
      params.push(updates.failure_reason);
    }
    if (updates.failure_type !== undefined) {
      fields.push(`failure_type = $${idx++}`);
      params.push(updates.failure_type);
    }
    if (updates.queued_at !== undefined) {
      fields.push(`queued_at = $${idx++}`);
      params.push(updates.queued_at);
    }
    if (updates.uid !== undefined) {
      fields.push(`uid = $${idx++}`);
      params.push(updates.uid);
    }
    if (updates.payment_expires_at !== undefined) {
      fields.push(`payment_expires_at = $${idx++}`);
      params.push(updates.payment_expires_at);
    }

    const sql = `
      UPDATE orders
      SET ${fields.join(', ')}
      WHERE order_no = $1
      RETURNING *;
    `;

    const result = await exec.query(sql, params);
    if (result.rows.length === 0) return null;
    return this.mapRowToOrder(result.rows[0]);
  }

  // Case 2: Atomic Claim with execution lock
  public async claimOrderAtomic(
    orderNo: string,
    botId: string,
    leaseSeconds: number,
    client: PoolClient
  ): Promise<Order | null> {
    // 1. SELECT FOR UPDATE SKIP LOCKED
    const selectSql = `
      SELECT * FROM orders
      WHERE order_no = $1 AND status = 'QUEUED'
      FOR UPDATE SKIP LOCKED;
    `;
    const selectRes = await client.query(selectSql, [orderNo]);
    if (selectRes.rows.length === 0) {
      return null; // Locked by another bot or already claimed
    }

    const currentOrder = this.mapRowToOrder(selectRes.rows[0]);
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

    // 2. Insert into bot_executions (unique constraint on order_no)
    await client.query(
      `INSERT INTO bot_executions (order_no, bot_id, claimed_at) VALUES ($1, $2, NOW())`,
      [orderNo, botId]
    );

    // 3. Update orders table to IN_PROGRESS with optimistic version check
    const updateSql = `
      UPDATE orders
      SET
        status = 'IN_PROGRESS',
        assigned_bot_id = $1,
        lease_expires_at = $2,
        last_heartbeat_at = NOW(),
        version = version + 1,
        updated_at = NOW()
      WHERE order_no = $3 AND status = 'QUEUED' AND version = $4
      RETURNING *;
    `;
    const updateRes = await client.query(updateSql, [
      botId,
      leaseExpiresAt,
      orderNo,
      currentOrder.version,
    ]);

    if (updateRes.rows.length === 0) {
      return null;
    }

    return this.mapRowToOrder(updateRes.rows[0]);
  }

  // Case 1: Heartbeat renewal
  public async updateHeartbeat(
    orderNo: string,
    botId: string,
    leaseSeconds: number,
    executor?: IDbExecutor
  ): Promise<Order | null> {
    const exec = this.getExecutor(executor);
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
    const sql = `
      UPDATE orders
      SET
        lease_expires_at = $1,
        last_heartbeat_at = NOW(),
        updated_at = NOW()
      WHERE order_no = $2 AND assigned_bot_id = $3 AND status = 'IN_PROGRESS'
      RETURNING *;
    `;
    const res = await exec.query(sql, [leaseExpiresAt, orderNo, botId]);
    if (res.rows.length === 0) return null;
    return this.mapRowToOrder(res.rows[0]);
  }

  // Case 1: Find orders where bot lease has expired
  public async findExpiredLeases(executor?: IDbExecutor): Promise<Order[]> {
    const exec = this.getExecutor(executor);
    const sql = `
      SELECT * FROM orders
      WHERE status = 'IN_PROGRESS' AND lease_expires_at < NOW()
      FOR UPDATE SKIP LOCKED;
    `;
    const res = await exec.query(sql);
    return res.rows.map((r) => this.mapRowToOrder(r));
  }

  // Case 5: Find orders where payment expired
  public async findExpiredPayments(executor?: IDbExecutor): Promise<Order[]> {
    const exec = this.getExecutor(executor);
    const sql = `
      SELECT * FROM orders
      WHERE status = 'PENDING_PAYMENT' AND payment_expires_at < NOW()
      FOR UPDATE SKIP LOCKED;
    `;
    const res = await exec.query(sql);
    return res.rows.map((r) => this.mapRowToOrder(r));
  }

  // Case 5: Find orders queued longer than SLA
  public async findExceededSlaQueued(slaMinutes: number, executor?: IDbExecutor): Promise<Order[]> {
    const exec = this.getExecutor(executor);
    const sql = `
      SELECT * FROM orders
      WHERE status = 'QUEUED' AND queued_at < (NOW() - ($1 || ' minutes')::INTERVAL)
      FOR UPDATE SKIP LOCKED;
    `;
    const res = await exec.query(sql, [slaMinutes]);
    return res.rows.map((r) => this.mapRowToOrder(r));
  }

  private mapRowToOrder(row: any): Order {
    return {
      id: row.id,
      order_no: row.order_no,
      customer_id: row.customer_id,
      game_id: row.game_id,
      package_id: row.package_id,
      uid: row.uid,
      server_id: row.server_id,
      amount: parseFloat(row.amount),
      status: row.status as OrderStatus,
      assigned_bot_id: row.assigned_bot_id,
      lease_expires_at: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
      retry_count: row.retry_count,
      max_retries: row.max_retries,
      last_heartbeat_at: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null,
      failure_reason: row.failure_reason,
      failure_type: row.failure_type as FailureType | null,
      payment_expires_at: new Date(row.payment_expires_at),
      queued_at: row.queued_at ? new Date(row.queued_at) : null,
      version: row.version,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
