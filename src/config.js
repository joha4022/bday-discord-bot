import dotenv from 'dotenv';

dotenv.config();

const required = [
  'DISCORD_TOKEN',
  'BDAY_CHANNEL_ID',
  'DATABASE_URL',
  'ADDRESS_ENCRYPTION_KEY'
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

export const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  GUILD_ID: process.env.GUILD_ID || null,
  BDAY_CHANNEL_ID: process.env.BDAY_CHANNEL_ID,
  DATABASE_URL: process.env.DATABASE_URL,
  ADDRESS_ENCRYPTION_KEY: process.env.ADDRESS_ENCRYPTION_KEY,
  TZ: process.env.TZ || 'America/Los_Angeles',
  DAILY_CRON: process.env.DAILY_CRON || '0 9 * * *',
  AUTO_DELETE_ARCHIVED_DAYS: parseInt(process.env.AUTO_DELETE_ARCHIVED_DAYS || '30', 10)
};
