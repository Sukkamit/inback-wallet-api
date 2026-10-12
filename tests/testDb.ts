import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { setCustomPool } from '../src/db/connection';

export function createTestDb(): Pool {
  const db = newDb({
    autoCreateForeignKeyIndices: true,
  });

  // Register gen_random_uuid() as an impure function
  db.public.registerFunction({
    name: 'gen_random_uuid',
    impure: true,
    implementation: () => require('crypto').randomUUID(),
  });

  // Read raw schema with native TIMESTAMPTZ
  const schemaPath = path.join(__dirname, '../src/db/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  db.public.none(schemaSql);

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
  return testPool as unknown as Pool;
}
