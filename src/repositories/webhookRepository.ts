import { getPool, IDbExecutor } from '../db/connection';

export class WebhookRepository {
  private getExecutor(executor?: IDbExecutor): IDbExecutor {
    return executor || getPool();
  }

  public async isEventProcessed(eventId: string, executor?: IDbExecutor): Promise<boolean> {
    const exec = this.getExecutor(executor);
    const sql = `SELECT 1 FROM webhook_events WHERE event_id = $1;`;
    const res = await exec.query(sql, [eventId]);
    return res.rows.length > 0;
  }

  public async recordEvent(
    event: {
      event_id: string;
      provider: string;
      order_no: string;
      payload: Record<string, unknown>;
      status: string;
    },
    executor?: IDbExecutor
  ): Promise<void> {
    const exec = this.getExecutor(executor);
    const sql = `
      INSERT INTO webhook_events (event_id, provider, order_no, payload, status, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (event_id) DO NOTHING;
    `;
    await exec.query(sql, [
      event.event_id,
      event.provider,
      event.order_no,
      JSON.stringify(event.payload),
      event.status,
    ]);
  }
}
