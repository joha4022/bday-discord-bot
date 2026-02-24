import pg from 'pg';
import { CONFIG } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL
});

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
