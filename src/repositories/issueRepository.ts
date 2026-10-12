import { getPool, IDbExecutor } from '../db/connection';
import { OrderIssue } from '../domain/types';

export class IssueRepository {
  private getExecutor(executor?: IDbExecutor): IDbExecutor {
    return executor || getPool();
  }

  public async create(
    issue: {
      order_no: string;
      reported_by: string;
      category: string;
      details: string;
    },
    executor?: IDbExecutor
  ): Promise<OrderIssue> {
    const exec = this.getExecutor(executor);
    const sql = `
      INSERT INTO order_issues (order_no, reported_by, category, details, resolution_status, created_at)
      VALUES ($1, $2, $3, $4, 'OPEN', NOW())
      RETURNING *;
    `;
    const params = [issue.order_no, issue.reported_by, issue.category, issue.details];
    const result = await exec.query(sql, params);
    return this.mapRowToIssue(result.rows[0]);
  }

  public async findByOrderNo(orderNo: string, executor?: IDbExecutor): Promise<OrderIssue[]> {
    const exec = this.getExecutor(executor);
    const sql = `
      SELECT * FROM order_issues
      WHERE order_no = $1
      ORDER BY created_at DESC;
    `;
    const result = await exec.query(sql, [orderNo]);
    return result.rows.map((r) => this.mapRowToIssue(r));
  }

  private mapRowToIssue(row: any): OrderIssue {
    return {
      id: row.id,
      order_no: row.order_no,
      reported_by: row.reported_by,
      category: row.category,
      details: row.details,
      resolution_status: row.resolution_status,
      created_at: new Date(row.created_at),
    };
  }
}
