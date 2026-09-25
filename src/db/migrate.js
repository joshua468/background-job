import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import config from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const schemaSql = await readFile(join(__dirname, 'schema.sql'), 'utf8');

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
    console.log('Migration applied successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});