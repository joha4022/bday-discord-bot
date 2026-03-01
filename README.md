# Bday Discord Bot

Discord bot for birthday gift cycles in a single `#bday` channel. Runs on Unraid via Docker with Postgres persistence, daily scheduler, encrypted addresses, and thread-based flows.

## Features
- Single channel with per-birthday threads (created T-21).
- Surprise mode: birthday person cannot view their thread.
- Suggest → `/poll` vote → winner (T-5) → claim → receipt → split by current thread members → `/paid` tracking.
- Birthday‑day DM reminder for unpaid participants (after receipt), then weekly until paid. The purchaser is excluded from owed balances and reminders.
- Purchaser overrides: `/mark-paid` and `/mark-unpaid`.
- AES‑256‑GCM encryption for address storage.
- Daily cron scheduler (no in‑memory timers only).

## Requirements
- Discord app + bot token.
- Unraid host with Docker.
- Postgres container (via `docker-compose.yml`).

## Setup
1. Copy `.env.template` to `.env` and fill:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `BDAY_CHANNEL_ID`
   - `DATABASE_URL` (already set for Docker compose)
   - `ADDRESS_ENCRYPTION_KEY` (32 bytes, hex or base64)
   - `TZ`
2. Start containers:
   ```sh
   docker compose up -d
   ```
3. The container will:
   - Install dependencies
   - Run DB migrations
   - Register slash commands
   - Start the bot

### Generate Encryption Key
```sh
openssl rand -hex 32
```

## Permissions
Ensure the bot has these permissions in the server and `#bday` channel:
- View Channel
- Send Messages
- Create Private Threads
- Manage Threads (for archiving)
- Read Message History
- Add Reactions
- Send Messages in Threads
- Manage Messages (optional, for cleanup)

Also enable the privileged Server Members Intent in the Discord developer portal, since the bot fetches the full guild member list when creating private birthday threads.

## Commands
Global:
- `/register birthday:YYYY-MM-DD` → opens private modals for address + payment info
- `/remove user:@User` → manager-only; removes that user from stored registrations

Thread-only:
- `/suggest url:<link>`
- `/poll`
- `/claim`
- `/receipt total:<number>` → splits by current thread members, excluding the birthday person and bot
- `/paid` → marks the caller paid if they were in the receipt snapshot; the purchaser is not counted in the paid checklist
- `/status`
- `/mark-paid user:@User [note]`
- `/mark-unpaid user:@User [note]`

If run outside a birthday thread, the bot responds with:
- “Please run this command inside a birthday thread.”

## Scheduler
- Daily cron set by `DAILY_CRON` (default: `0 9 * * *` local time).
- Creates threads at T‑21, closes voting at T‑5, sends reminders on the birthday date (after receipt) and weekly until all non-purchaser participants are paid, and archives when complete.

## Data Storage
- Postgres tables: `users`, `circles`, `cycles`, `suggestions`, `payments`, `registration_sessions`.
- Addresses are encrypted before storage and only decrypted for purchaser DMs.
- Removing a user clears their saved registration, but does not retroactively delete existing cycle history.

## Backups
- Nightly `pg_dump` to `/mnt/user/backups/autogift/`
- Retention: last 30 dumps

## Troubleshooting
- Commands not appearing: re-run in container `npm run register:commands`.
- Permissions issues: verify thread permissions for bot and channel.
- Encryption errors: confirm `ADDRESS_ENCRYPTION_KEY` is exactly 32 bytes.

## Files
- `src/index.js` — bot logic and scheduler
- `src/migrate.js` — schema creation
- `docker-compose.yml` — services
- `docker/backup/backup.sh` — backup cron script
