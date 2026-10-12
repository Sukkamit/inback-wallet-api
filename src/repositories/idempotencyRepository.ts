import { getPool, IDbExecutor } from '../db/connection';

export interface IdempotencyRecord {
  key: string;
  resource_type: string;
  response_status: number;
  response_body: Record<string, unknown>;
  created_at: Date;
  expires_at: Date;
}

export class IdempotencyRepository {
  private getExecutor(executor?: IDbExecutor): IDbExecutor {
    return executor || getPool();
  }

  public async get(key: string, executor?: IDbExecutor): Promise<IdempotencyRecord | null> {
    const exec = this.getExecutor(executor);
    const sql = `
      SELECT * FROM idempotency_keys
      WHERE key = $1 AND expires_at > NOW();
    `;
    const res = await exec.query(sql, [key]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      key: row.key,
      resource_type: row.resource_type,
      response_status: row.response_status,
      response_body: typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body,
      created_at: new Date(row.created_at),
      expires_at: new Date(row.expires_at),
    };
  }

  public async save(
    record: {
      key: string;
      resource_type: string;
      response_status: number;
      response_body: Record<string, unknown>;
      ttlHours?: number;
    },
    executor?: IDbExecutor
  ): Promise<void> {
    const exec = this.getExecutor(executor);
    const ttl = record.ttlHours || 24;
    const expiresAt = new Date(Date.now() + ttl * 3600 * 1000);
    const sql = `
      INSERT INTO idempotency_keys (key, resource_type, response_status, response_body, created_at, expires_at)
      VALUES ($1, $2, $3, $4, NOW(), $5)
      ON CONFLICT (key) DO UPDATE
      SET response_status = $3, response_body = $4, expires_at = $5;
    `;
    await exec.query(sql, [
      record.key,
      record.resource_type,
      record.response_status,
      JSON.stringify(record.response_body),
      expiresAt,
    ]);
  }
}
