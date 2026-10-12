import fs from 'fs';
import path from 'path';
import { getPool } from './connection';
import { logger } from '../utils/logger';

export function getSchemaSql(): string {
  const candidatePaths = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '../src/db/schema.sql'),
    path.resolve(process.cwd(), 'src/db/schema.sql'),
    path.resolve(process.cwd(), 'dist/db/schema.sql'),
  ];
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  throw new Error(`schema.sql not found in candidate paths: ${candidatePaths.join(', ')}`);
}

export async function runMigrations(): Promise<void> {
  const schemaSql = getSchemaSql();

  const pool = getPool();
  try {
    logger.info('Running database migrations...');
    await pool.query(schemaSql);
    logger.info('Database migrations applied successfully.');
  } catch (error) {
    logger.error('Failed to run database migrations', { error: (error as Error).message });
    throw error;
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      logger.info('Migration complete');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Migration failed', { error: err.message });
      process.exit(1);
    });
}
