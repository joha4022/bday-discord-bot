import { withClient } from './db.js';

const sql = `
CREATE TABLE IF NOT EXISTS users (
  discord_user_id TEXT PRIMARY KEY,
  birthday DATE NOT NULL,
  venmo TEXT,
  zelle TEXT,
  name TEXT,
  address_ciphertext TEXT NOT NULL,
  address_iv TEXT NOT NULL,
  address_version INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS circles (
  guild_id TEXT PRIMARY KEY,
  bday_channel_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  birthday_discord_user_id TEXT NOT NULL,
  birthday_date DATE NOT NULL,
  thread_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  winner_suggestion_id INT,
  purchaser_discord_user_id TEXT,
  receipt_total NUMERIC(10,2),
  receipt_at TIMESTAMPTZ,
  participants_snapshot_json JSONB,
  paid_status_message_id TEXT,
  reminder_sent_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (guild_id, birthday_discord_user_id, birthday_date)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id SERIAL PRIMARY KEY,
  cycle_id INT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  suggester_discord_user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  price TEXT,
  message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  cycle_id INT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  payer_discord_user_id TEXT NOT NULL,
  paid_at TIMESTAMPTZ,
  override_by_purchaser BOOLEAN DEFAULT FALSE,
  note TEXT,
  UNIQUE (cycle_id, payer_discord_user_id)
);

CREATE TABLE IF NOT EXISTS registration_sessions (
  discord_user_id TEXT PRIMARY KEY,
  birthday DATE NOT NULL,
  data_json JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cycles_status ON cycles(status);
CREATE INDEX IF NOT EXISTS idx_cycles_receipt_at ON cycles(receipt_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_cycle ON suggestions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_payments_cycle ON payments(cycle_id);
`;

await withClient(async (client) => {
  await client.query(sql);
});

console.log('Migrations applied.');
process.exit(0);
