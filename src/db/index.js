import pg from 'pg';
import config from '../config/index.js';

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export const query = (text, params) => pool.query(text, params);

export const closePool = () => pool.end();

export default pool;