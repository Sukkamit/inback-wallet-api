import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { setCustomPool } from './connection';
import { logger } from '../utils/logger';

export function initEmbeddedDb(): Pool {
  logger.warn('⚠️  [Database Fallback]: External PostgreSQL connection failed.');
  logger.info('🔄 Initializing in-memory PostgreSQL engine (pg-mem) with schema...');

  const db = newDb({
    autoCreateForeignKeyIndices: true,
  });

  db.public.registerFunction({
    name: 'gen_random_uuid',
    impure: true,
    implementation: () => require('crypto').randomUUID(),
  });

  const candidatePaths = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '../src/db/schema.sql'),
    path.resolve(process.cwd(), 'src/db/schema.sql'),
    path.resolve(process.cwd(), 'dist/db/schema.sql'),
  ];
  let schemaSql = '';
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      schemaSql = fs.readFileSync(candidate, 'utf8');
      break;
    }
  }

  if (schemaSql) {
    db.public.none(schemaSql);
  }

  const pg = db.adapters.createPg();
  const testPool = new pg.Pool();

  const stripLocks = (text: any) => {
    if (typeof text === 'string') {
      return text.replace(/FOR UPDATE SKIP LOCKED/gi, '').replace(/FOR UPDATE/gi, '');
    }
    if (text && text.text) {
      text.text = text.text.replace(/FOR UPDATE SKIP LOCKED/gi, '').replace(/FOR UPDATE/gi, '');
    }
    return text;
  };

  const origPoolQuery = testPool.query.bind(testPool);
  (testPool as any).query = function (text: any, params?: any) {
    return origPoolQuery(stripLocks(text), params);
  };

  const origConnect = testPool.connect.bind(testPool);
  (testPool as any).connect = async function (): Promise<PoolClient> {
    const client = await origConnect();
    const origClientQuery = client.query.bind(client);
    client.query = function (text: any, params?: any) {
      return origClientQuery(stripLocks(text), params);
    } as any;
    return client;
  };

  setCustomPool(testPool as unknown as Pool);
  logger.info('✅ In-memory database ready! Application and Demo Dashboard can be used without local PostgreSQL.');
  return testPool as unknown as Pool;
}
