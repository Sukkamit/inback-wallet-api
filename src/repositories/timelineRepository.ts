import { getPool, IDbExecutor } from '../db/connection';
import { OrderTimeline, OrderStatus, ActorType } from '../domain/types';

export class TimelineRepository {
  private getExecutor(executor?: IDbExecutor): IDbExecutor {
    return executor || getPool();
  }

  public async record(
    timeline: {
      order_id: string;
      order_no: string;
      from_status: OrderStatus | null;
      to_status: OrderStatus;
      actor_type: ActorType;
      actor_id?: string | null;
      action: string;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
    },
    executor?: IDbExecutor
  ): Promise<OrderTimeline> {
    const exec = this.getExecutor(executor);
    const sql = `
      INSERT INTO order_timelines (
        order_id, order_no, from_status, to_status,
        actor_type, actor_id, action, reason, metadata, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *;
    `;
    const params = [
      timeline.order_id,
      timeline.order_no,
      timeline.from_status,
      timeline.to_status,
      timeline.actor_type,
      timeline.actor_id || null,
      timeline.action,
      timeline.reason || null,
      timeline.metadata ? JSON.stringify(timeline.metadata) : null,
    ];

    const result = await exec.query(sql, params);
    return this.mapRowToTimeline(result.rows[0]);
  }

  public async findByOrderNo(orderNo: string, executor?: IDbExecutor): Promise<OrderTimeline[]> {
    const exec = this.getExecutor(executor);
    const sql = `
      SELECT * FROM order_timelines
      WHERE order_no = $1
      ORDER BY created_at ASC;
    `;
    const result = await exec.query(sql, [orderNo]);
    return result.rows.map((row) => this.mapRowToTimeline(row));
  }

  private mapRowToTimeline(row: any): OrderTimeline {
    return {
      id: row.id,
      order_id: row.order_id,
      order_no: row.order_no,
      from_status: row.from_status as OrderStatus | null,
      to_status: row.to_status as OrderStatus,
      actor_type: row.actor_type as ActorType,
      actor_id: row.actor_id,
      action: row.action,
      reason: row.reason,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      created_at: new Date(row.created_at),
    };
  }
}
