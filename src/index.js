import {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder
} from 'discord.js';
import cron from 'node-cron';
import { CONFIG } from './config.js';
import { withClient } from './db.js';
import { encryptAddress, decryptAddress } from './encryption.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

const NOTIFICATIONS_ENABLED = String(process.env.NOTIFICATIONS_ENABLED ?? 'true').toLowerCase() !== 'false';
let dailyCheckRunning = false;

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toTzDateString(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function parseBirthday(str) {
  if (!str) return null;
  const s = str.trim().replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function parseDateOnly(str) {
  const [y, m, d] = str.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function parseCityState(input) {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes(',')) {
    const parts = raw.split(',');
    const state = parts.pop().trim();
    const city = parts.join(',').trim();
    if (city && state) return { city, state };
    return null;
  }
  const lastSpace = raw.lastIndexOf(' ');
  if (lastSpace === -1) return null;
  const city = raw.slice(0, lastSpace).trim();
  const state = raw.slice(lastSpace + 1).trim();
  if (city && state) return { city, state };
  return null;
}

async function fetchUrlMeta(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'CircleBot/1.0' }
    });
    clearTimeout(timeout);
    if (!res.ok) return { title: null, price: null };
    const text = (await res.text()).slice(0, 200000);
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const priceMatch = text.match(/\$\s?([0-9]+(?:\.[0-9]{2})?)/);
    const price = priceMatch ? `$${priceMatch[1]}` : null;
    return { title, price };
  } catch {
    return { title: null, price: null };
  }
}

async function getGuildAndChannel() {
  let guild = null;
  if (CONFIG.GUILD_ID) {
    guild = await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null);
  } else {
    const fetchedChannel = await client.channels.fetch(CONFIG.BDAY_CHANNEL_ID).catch(() => null);
    if (fetchedChannel && fetchedChannel.guild) {
      return { guild: fetchedChannel.guild, channel: fetchedChannel };
    }
    guild = client.guilds.cache.first() || null;
  }
  if (!guild) return { guild: null, channel: null };
  const channel = await guild.channels.fetch(CONFIG.BDAY_CHANNEL_ID).catch(() => null);
  return { guild, channel };
}

async function getCycleByThread(threadId) {
  return await withClient(async (db) => {
    const res = await db.query('SELECT * FROM cycles WHERE thread_id = $1', [threadId]);
    return res.rows[0] || null;
  });
}

async function getUserRow(userId) {
  return await withClient(async (db) => {
    const res = await db.query('SELECT * FROM users WHERE discord_user_id = $1', [userId]);
    return res.rows[0] || null;
  });
}

async function ensureCircle(guildId) {
  await withClient(async (db) => {
    await db.query(
      'INSERT INTO circles (guild_id, bday_channel_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET bday_channel_id = EXCLUDED.bday_channel_id',
      [guildId, CONFIG.BDAY_CHANNEL_ID]
    );
  });
}

async function getParticipantsForChannel(channel, birthdayUserId) {
  const guild = channel.guild;
  await guild.members.fetch();
  const members = guild.members.cache.filter((m) => !m.user.bot);
  const participants = [];
  for (const member of members.values()) {
    if (member.id === birthdayUserId) continue;
    const perms = channel.permissionsFor(member);
    if (perms && perms.has('ViewChannel')) {
      participants.push(member.id);
    }
  }
  return participants;
}

async function postPaidStatus(thread, cycleId, participants, guild) {
  const payments = await withClient(async (db) => {
    const res = await db.query('SELECT payer_discord_user_id, paid_at FROM payments WHERE cycle_id = $1', [cycleId]);
    return res.rows;
  });
  const paidSet = new Set(payments.filter((p) => p.paid_at).map((p) => p.payer_discord_user_id));
  await guild.members.fetch();
  const lines = participants.map((id) => {
    const member = guild.members.cache.get(id);
    const name = member ? member.displayName : id;
    const mark = paidSet.has(id) ? '✅' : '❌';
    return `${mark} ${name}`;
  });
  const content = `**Paid Status**\n${lines.join('\n')}`;

  const cycle = await withClient(async (db) => {
    const res = await db.query('SELECT paid_status_message_id FROM cycles WHERE id = $1', [cycleId]);
    return res.rows[0];
  });

  if (cycle && cycle.paid_status_message_id) {
    const msg = await thread.messages.fetch(cycle.paid_status_message_id).catch(() => null);
    if (msg) {
      try {
        await msg.edit(content);
        return;
      } catch (err) {
        console.error(`Failed to edit paid status message for cycle ${cycleId}:`, err);
      }
    }
  }

  const msg = await thread.send(content);
  await withClient(async (db) => {
    await db.query('UPDATE cycles SET paid_status_message_id = $1 WHERE id = $2', [msg.id, cycleId]);
  });
}

async function updatePayment(thread, cycle, payerId, paidAt, override, note) {
  await withClient(async (db) => {
    await db.query(
      `INSERT INTO payments (cycle_id, payer_discord_user_id, paid_at, override_by_purchaser, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cycle_id, payer_discord_user_id)
       DO UPDATE SET paid_at = $3, override_by_purchaser = $4, note = $5`,
      [cycle.id, payerId, paidAt, override, note || null]
    );
  });

  const participants = cycle.participants_snapshot_json || [];
  await postPaidStatus(thread, cycle.id, participants, thread.guild);
}

async function handleRegisterModal(interaction) {
  const session = await withClient(async (db) => {
    const res = await db.query('SELECT birthday FROM registration_sessions WHERE discord_user_id = $1', [interaction.user.id]);
    return res.rows[0];
  });
  if (!session) {
    await interaction.reply({ content: 'Registration session expired. Please run /register again.', flags: MessageFlags.Ephemeral });
    return;
  }
  const birthdayStr = session.birthday instanceof Date
    ? toLocalDateString(session.birthday)
    : String(session.birthday).trim();
  if (!parseBirthday(birthdayStr)) {
    await interaction.reply({
      content: `Invalid birthday format. Use YYYY-MM-DD. Received: "${birthdayStr}"`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const addressLine1 = interaction.fields.getTextInputValue('address_line1').trim();
  const cityStateRaw = interaction.fields.getTextInputValue('city_state');
  const cityState = parseCityState(cityStateRaw);
  const postalCode = interaction.fields.getTextInputValue('postalCode').trim();
  if (!addressLine1 || !cityState || !postalCode) {
    await interaction.reply({
      content: 'Please provide Address Line 1, City/State, and ZIP / Postal Code.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const address = {
    line1: addressLine1,
    line2: null,
    city: cityState.city,
    state: cityState.state,
    postalCode,
    country: 'US'
  };

  const encrypted = encryptAddress(address);
  const venmo = interaction.fields.getTextInputValue('venmoHandle').trim() || null;
  const zelle = interaction.fields.getTextInputValue('zelleInfo').trim() || null;

  const existed = await withClient(async (db) => {
    const res = await db.query('SELECT 1 FROM users WHERE discord_user_id = $1', [interaction.user.id]);
    return res.rowCount === 1;
  });

  await withClient(async (db) => {
    await db.query(
      `INSERT INTO users (discord_user_id, birthday, venmo, zelle, name, address_ciphertext, address_iv, address_version)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET birthday = EXCLUDED.birthday, venmo = EXCLUDED.venmo, zelle = EXCLUDED.zelle,
       address_ciphertext = EXCLUDED.address_ciphertext, address_iv = EXCLUDED.address_iv, address_version = EXCLUDED.address_version,
       updated_at = NOW()`,
      [interaction.user.id, birthdayStr, venmo, zelle, encrypted.ciphertext, encrypted.iv, encrypted.version]
    );
    await db.query('DELETE FROM registration_sessions WHERE discord_user_id = $1', [interaction.user.id]);
  });

  await interaction.reply({ content: existed ? 'Registration updated.' : 'Registration saved.', flags: MessageFlags.Ephemeral });
}

function ensureThreadOnly(interaction) {
  const channel = interaction.channel;
  if (!channel || !channel.isThread() || channel.parentId !== CONFIG.BDAY_CHANNEL_ID) {
    return false;
  }
  return true;
}

async function handleSuggest(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id === cycle.birthday_discord_user_id) {
    await interaction.reply({ content: 'Birthday person cannot suggest.', flags: MessageFlags.Ephemeral });
    return;
  }

  const url = interaction.options.getString('url');
  const { count, latest } = await withClient(async (db) => {
    const res = await db.query(
      'SELECT COUNT(*)::int AS count, MAX(created_at) AS latest FROM suggestions WHERE cycle_id = $1 AND suggester_discord_user_id = $2',
      [cycle.id, interaction.user.id]
    );
    return res.rows[0];
  });

  if (count >= 3) {
    await interaction.reply({ content: 'Suggestion limit reached (3 per user).', flags: MessageFlags.Ephemeral });
    return;
  }
  if (latest) {
    const diff = Date.now() - new Date(latest).getTime();
    if (diff < 60 * 1000) {
      await interaction.reply({ content: 'Please wait 1 minute between suggestions.', flags: MessageFlags.Ephemeral });
      return;
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const meta = await fetchUrlMeta(url);
  const embed = new EmbedBuilder()
    .setTitle(meta.title || 'Gift Suggestion')
    .setDescription(url)
    .setColor(0x2f855a);
  if (meta.price) {
    embed.addFields({ name: 'Price', value: meta.price, inline: true });
  }

  const msg = await interaction.channel.send({ embeds: [embed] });
  await msg.react('👍');

  await withClient(async (db) => {
    await db.query(
      `INSERT INTO suggestions (cycle_id, suggester_discord_user_id, url, title, price, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [cycle.id, interaction.user.id, url, meta.title, meta.price, msg.id]
    );
  });

  await interaction.editReply('Suggestion posted.');
}

async function handleClaim(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!cycle.winner_suggestion_id) {
    await interaction.reply({ content: 'Voting is not closed yet.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id === cycle.birthday_discord_user_id) {
    await interaction.reply({ content: 'Birthday person cannot claim.', flags: MessageFlags.Ephemeral });
    return;
  }

  const updated = await withClient(async (db) => {
    const res = await db.query(
      `UPDATE cycles SET purchaser_discord_user_id = $1, status = 'claimed', updated_at = NOW()
       WHERE id = $2 AND purchaser_discord_user_id IS NULL`,
      [interaction.user.id, cycle.id]
    );
    return res.rowCount === 1;
  });

  if (!updated) {
    await interaction.reply({ content: 'Purchaser already claimed.', flags: MessageFlags.Ephemeral });
    return;
  }

  const suggestion = await withClient(async (db) => {
    const res = await db.query('SELECT * FROM suggestions WHERE id = $1', [cycle.winner_suggestion_id]);
    return res.rows[0] || null;
  });

  const birthdayUser = await getUserRow(cycle.birthday_discord_user_id);
  if (birthdayUser) {
    const address = decryptAddress({ ciphertext: birthdayUser.address_ciphertext, iv: birthdayUser.address_iv });
    const dm = await interaction.user.createDM();
    await dm.send(
      `You claimed the gift!\nWinning link: ${suggestion ? suggestion.url : 'N/A'}\n\nShip to:\n${address.line1}${address.line2 ? `\n${address.line2}` : ''}\n${address.city}, ${address.state} ${address.postalCode}\n${address.country}`
    );
  }

  await interaction.reply({ content: 'You are the purchaser. Check your DMs for the address.', flags: MessageFlags.Ephemeral });
}

async function handleReceipt(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== cycle.purchaser_discord_user_id) {
    await interaction.reply({ content: 'Only the purchaser can post the receipt.', flags: MessageFlags.Ephemeral });
    return;
  }

  const total = interaction.options.getNumber('total');
  if (!total || total <= 0) {
    await interaction.reply({ content: 'Invalid receipt total.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { channel } = await getGuildAndChannel();
  if (!channel) {
    await interaction.reply({ content: 'Channel not found.', flags: MessageFlags.Ephemeral });
    return;
  }
  const participants = await getParticipantsForChannel(channel, cycle.birthday_discord_user_id);
  const count = participants.length;
  if (count === 0) {
    await interaction.reply({ content: 'No participants found for split.', flags: MessageFlags.Ephemeral });
    return;
  }
  const split = Math.round((total / count) * 100) / 100;

  await withClient(async (db) => {
    await db.query(
      `UPDATE cycles SET receipt_total = $1, receipt_at = NOW(), participants_snapshot_json = $2, status = 'receipt_posted', updated_at = NOW()
       WHERE id = $3`,
      [total.toFixed(2), JSON.stringify(participants), cycle.id]
    );

    for (const id of participants) {
      await db.query(
        `INSERT INTO payments (cycle_id, payer_discord_user_id)
         VALUES ($1, $2)
         ON CONFLICT (cycle_id, payer_discord_user_id) DO NOTHING`,
        [cycle.id, id]
      );
    }
  });

  const purchaserUser = await getUserRow(cycle.purchaser_discord_user_id);
  const payLines = [];
  if (purchaserUser?.venmo) payLines.push(`Venmo: ${purchaserUser.venmo}`);
  if (purchaserUser?.zelle) payLines.push(`Zelle: ${purchaserUser.zelle}`);

  await interaction.reply({
    content: `Receipt saved. Split is $${split.toFixed(2)} per person.\n${payLines.join('\n') || 'No payment handle on file.'}\nPlease pay and then run /paid.`
  });

  await postPaidStatus(interaction.channel, cycle.id, participants, interaction.guild);
}

async function handlePaid(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle || !cycle.participants_snapshot_json) {
    await interaction.reply({ content: 'Receipt not posted yet.', flags: MessageFlags.Ephemeral });
    return;
  }
  const participants = cycle.participants_snapshot_json || [];
  if (!participants.includes(interaction.user.id)) {
    await interaction.reply({ content: 'You are not in the participant list for this cycle.', flags: MessageFlags.Ephemeral });
    return;
  }

  await updatePayment(interaction.channel, cycle, interaction.user.id, new Date().toISOString(), false, null);
  await interaction.reply({ content: 'Marked as paid.', flags: MessageFlags.Ephemeral });
}

async function handleStatus(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const purchaser = cycle.purchaser_discord_user_id ? `<@${cycle.purchaser_discord_user_id}>` : 'Unclaimed';
  const winner = cycle.winner_suggestion_id ? 'Selected' : 'Pending';
  const receipt = cycle.receipt_total ? `$${Number(cycle.receipt_total).toFixed(2)}` : 'Not posted';
  await interaction.reply({
    content: `Status:\nWinner: ${winner}\nPurchaser: ${purchaser}\nReceipt: ${receipt}`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleProfile(interaction) {
  const user = await getUserRow(interaction.user.id);
  if (!user) {
    await interaction.reply({ content: 'No profile found. Use /register first.', flags: MessageFlags.Ephemeral });
    return;
  }
  const address = decryptAddress({ ciphertext: user.address_ciphertext, iv: user.address_iv });
  const masked = `${address.city}, ${address.state}${address.country ? ` (${address.country})` : ''}`;
  const lines = [
    `Birthday: ${String(user.birthday).slice(0, 10)}`,
    `Address: ${masked}`,
    `Venmo: ${user.venmo || 'Not set'}`,
    `Zelle: ${user.zelle || 'Not set'}`
  ];
  await interaction.reply({ content: lines.join('\\n'), flags: MessageFlags.Ephemeral });
}

async function handleMarkPaid(interaction, isPaid) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== cycle.purchaser_discord_user_id) {
    await interaction.reply({ content: 'Only the purchaser can use this.', flags: MessageFlags.Ephemeral });
    return;
  }

  const target = interaction.options.getUser('user');
  const note = interaction.options.getString('note');

  await updatePayment(interaction.channel, cycle, target.id, isPaid ? new Date().toISOString() : null, true, note);

  await interaction.reply({ content: `${target.username} marked as ${isPaid ? 'paid' : 'unpaid'}.`, flags: MessageFlags.Ephemeral });
  await interaction.channel.send(`Audit: ${interaction.user.username} marked ${target.username} as ${isPaid ? 'paid' : 'unpaid'}${note ? ` (${note})` : ''}.`);
}

async function dailyCheck() {
  console.log('dailyCheck: start');
  const { guild, channel } = await getGuildAndChannel();
  if (!guild || !channel) {
    console.log(`dailyCheck: missing guild/channel (guild=${guild ? 'ok' : 'null'} channel=${channel ? 'ok' : 'null'})`);
    return;
  }
  await ensureCircle(guild.id);

  const today = new Date();
  const todayStr = toTzDateString(today);
  console.log(`dailyCheck: todayStr=${todayStr}`);

  // Create threads at T-21
  const users = await withClient(async (db) => {
    const res = await db.query('SELECT * FROM users');
    return res.rows;
  });
  console.log(`dailyCheck: users=${users.length}`);

  for (const user of users) {
    try {
      const raw = user.birthday.toISOString ? toTzDateString(user.birthday) : String(user.birthday).slice(0, 10);
      const userBday = parseDateOnly(raw);
      const bday = new Date(today.getFullYear(), userBday.getMonth(), userBday.getDate());
      const triggerDate = addDays(bday, -21);
      const birthdayStr = toTzDateString(bday);
      const triggerStr = toTzDateString(triggerDate);
      if (triggerStr !== todayStr) {
        console.log(`Skipping ${user.discord_user_id}: birthdayStr=${birthdayStr} triggerStr=${triggerStr} todayStr=${todayStr}`);
        continue;
      }

      const claim = await withClient(async (db) => {
        const res = await db.query(
          `INSERT INTO cycles (guild_id, birthday_discord_user_id, birthday_date, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'planning', NOW(), NOW())
           ON CONFLICT (guild_id, birthday_discord_user_id, birthday_date)
           DO NOTHING
           RETURNING id`,
          [guild.id, user.discord_user_id, birthdayStr]
        );
        return res.rows[0];
      });

      if (!claim) continue;

      const nameBase = user.name || (await guild.members.fetch(user.discord_user_id).catch(() => null))?.displayName || 'member';
      const threadName = `${nameBase.toLowerCase().replace(/\s+/g, '-')}-${toLocalDateString(bday)}`;

      const thread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: 'Birthday cycle starting'
      });

      await thread.permissionOverwrites.edit(user.discord_user_id, { ViewChannel: false });

      await withClient(async (db) => {
        await db.query(
          "UPDATE cycles SET thread_id = $1, status = 'open', updated_at = NOW() WHERE id = $2",
          [thread.id, claim.id]
        );
      });

      if (!NOTIFICATIONS_ENABLED) {
        console.log('NOTIFICATIONS_ENABLED=false: skipping DMs');
      } else {
        const members = await thread.members.fetch().catch(() => null);
        if (members) {
          for (const [memberId, member] of members) {
            if (memberId === user.discord_user_id) continue;
            if (memberId === client.user.id) continue;
            try {
              await member.user.send(`New birthday thread created: ${thread.name}\n${thread.url}`);
            } catch (err) {
              console.error(`DM failed for ${memberId}: ${err?.message || err}`);
            }
          }
        }
      }

      await thread.send(
        'Welcome! Flow: suggest gifts with /suggest, vote with 👍, winner picked at T-5. After winner: /claim, then purchaser posts /receipt. Participants use /paid.'
      );
    } catch (err) {
      console.error(`dailyCheck user loop failed for ${user.discord_user_id}:`, err);
    }
  }

  // Close voting at T-5
  const openCycles = await withClient(async (db) => {
    const res = await db.query("SELECT * FROM cycles WHERE status = 'open' AND thread_id IS NOT NULL");
    return res.rows;
  });

  for (const cycle of openCycles) {
    try {
      const bday = parseDateOnly(String(cycle.birthday_date).slice(0, 10));
      const closeDate = addDays(bday, -5);
      if (toLocalDateString(closeDate) !== todayStr) continue;

      const thread = await guild.channels.fetch(cycle.thread_id).catch(() => null);
      if (!thread) continue;

      const suggestions = await withClient(async (db) => {
        const res = await db.query('SELECT * FROM suggestions WHERE cycle_id = $1 ORDER BY created_at ASC', [cycle.id]);
        return res.rows;
      });

      let winner = null;
      let maxVotes = -1;
      for (const s of suggestions) {
        if (!s.message_id) continue;
        const msg = await thread.messages.fetch(s.message_id).catch(() => null);
        if (!msg) continue;
        const reaction = msg.reactions.resolve('👍');
        let count = reaction ? reaction.count : 0;
        if (reaction?.me) count = Math.max(0, count - 1);
        if (count > maxVotes) {
          maxVotes = count;
          winner = s;
        }
      }

      if (winner) {
        await withClient(async (db) => {
          await db.query(
            `UPDATE cycles SET winner_suggestion_id = $1, status = 'voting_closed', updated_at = NOW()
             WHERE id = $2`,
            [winner.id, cycle.id]
          );
        });
        await thread.send(`Voting closed! Winner: ${winner.title || 'Gift'} (${winner.url})`);
      } else {
        await thread.send('Voting closed! No suggestions received.');
        await withClient(async (db) => {
          await db.query("UPDATE cycles SET status = 'voting_closed', updated_at = NOW() WHERE id = $1", [cycle.id]);
        });
      }
    } catch (err) {
      console.error(`dailyCheck openCycles loop failed for cycle ${cycle.id}:`, err);
    }
  }

  // 7-day reminders after receipt
  const reminderCycles = await withClient(async (db) => {
    const res = await db.query(
      "SELECT * FROM cycles WHERE receipt_at IS NOT NULL AND reminder_sent_at IS NULL AND participants_snapshot_json IS NOT NULL"
    );
    return res.rows;
  });

  for (const cycle of reminderCycles) {
    try {
      const receiptAt = new Date(cycle.receipt_at);
      const remindDate = addDays(receiptAt, 7);
      if (toLocalDateString(remindDate) !== todayStr) continue;

      const participants = cycle.participants_snapshot_json || [];
      const payments = await withClient(async (db) => {
        const res = await db.query('SELECT payer_discord_user_id, paid_at FROM payments WHERE cycle_id = $1', [cycle.id]);
        return res.rows;
      });
      const unpaid = participants.filter((id) => !payments.find((p) => p.payer_discord_user_id === id && p.paid_at));
      const split = Math.round((Number(cycle.receipt_total) / participants.length) * 100) / 100;

      if (unpaid.length > 0) {
        for (const userId of unpaid) {
          try {
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) continue;
            await user.send(
              `Reminder: Please pay $${split.toFixed(2)} for <@${cycle.birthday_discord_user_id}> and then type /paid in the thread.`
            );
          } catch (err) {
            console.error(`Reminder DM failed for ${userId}: ${err?.message || err}`);
          }
        }
      }

      await withClient(async (db) => {
        await db.query('UPDATE cycles SET reminder_sent_at = NOW() WHERE id = $1', [cycle.id]);
      });
    } catch (err) {
      console.error(`dailyCheck reminder loop failed for cycle ${cycle.id}:`, err);
    }
  }

  // Completion & archive
  const receiptCycles = await withClient(async (db) => {
    const res = await db.query(
      "SELECT * FROM cycles WHERE receipt_at IS NOT NULL AND participants_snapshot_json IS NOT NULL AND archived_at IS NULL"
    );
    return res.rows;
  });

  for (const cycle of receiptCycles) {
    try {
      const bday = parseDateOnly(String(cycle.birthday_date).slice(0, 10));
      const doneDate = addDays(bday, 1);
      if (toLocalDateString(doneDate) > todayStr) continue;

      const participants = cycle.participants_snapshot_json || [];
      const payments = await withClient(async (db) => {
        const res = await db.query('SELECT payer_discord_user_id, paid_at FROM payments WHERE cycle_id = $1', [cycle.id]);
        return res.rows;
      });
      const allPaid = participants.every((id) => payments.find((p) => p.payer_discord_user_id === id && p.paid_at));
      if (!allPaid) continue;

      const thread = await guild.channels.fetch(cycle.thread_id).catch(() => null);
      if (!thread) continue;

      await thread.send('All payments complete. Thread will be archived.');
      await thread.setArchived(true);

      await withClient(async (db) => {
        await db.query("UPDATE cycles SET status = 'completed', archived_at = NOW() WHERE id = $1", [cycle.id]);
      });
    } catch (err) {
      console.error(`dailyCheck receipt loop failed for cycle ${cycle.id}:`, err);
    }
  }

  // Optional delete archived threads after N days
  if (CONFIG.AUTO_DELETE_ARCHIVED_DAYS > 0) {
    const archived = await withClient(async (db) => {
      const res = await db.query(
        'SELECT * FROM cycles WHERE archived_at IS NOT NULL'
      );
      return res.rows;
    });

    for (const cycle of archived) {
      try {
        const delDate = addDays(new Date(cycle.archived_at), CONFIG.AUTO_DELETE_ARCHIVED_DAYS);
        if (toLocalDateString(delDate) !== todayStr) continue;
        const thread = await guild.channels.fetch(cycle.thread_id).catch(() => null);
        if (thread) {
          await thread.delete().catch(() => null);
        }
      } catch (err) {
        console.error(`dailyCheck archive cleanup failed for cycle ${cycle.id}:`, err);
      }
    }
  }
}

async function dailyCheckGuarded() {
  if (dailyCheckRunning) return;
  dailyCheckRunning = true;
  try {
    await dailyCheck();
  } finally {
    dailyCheckRunning = false;
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'register': {
          const birthdayRaw = interaction.options.getString('birthday', true);
          const date = parseBirthday(birthdayRaw);
          if (!date) {
            await interaction.reply({
              content: `Invalid birthday format. Use YYYY-MM-DD. Received: "${birthdayRaw}"`,
              flags: MessageFlags.Ephemeral
            });
            return;
          }
          const birthdayStr = toLocalDateString(date);

          await withClient(async (db) => {
            await db.query(
              `INSERT INTO registration_sessions (discord_user_id, birthday, data_json)
               VALUES ($1, $2, $3)
               ON CONFLICT (discord_user_id)
               DO UPDATE SET birthday = EXCLUDED.birthday, data_json = EXCLUDED.data_json, created_at = NOW()`,
              [interaction.user.id, birthdayStr, JSON.stringify({})]
            );
          });

          const modal = new ModalBuilder()
            .setCustomId('register_step_1')
            .setTitle('Birthday Registration');

          const address1 = new TextInputBuilder()
            .setCustomId('address_line1')
            .setLabel('Address Line 1 (Apt/Suite if needed)')
            .setRequired(true)
            .setStyle(TextInputStyle.Short);

          const city = new TextInputBuilder()
            .setCustomId('city_state')
            .setLabel('City, State')
            .setRequired(true)
            .setStyle(TextInputStyle.Short);

          const postal = new TextInputBuilder()
            .setCustomId('postalCode')
            .setLabel('ZIP / Postal Code')
            .setRequired(true)
            .setStyle(TextInputStyle.Short);

          const venmo = new TextInputBuilder()
            .setCustomId('venmoHandle')
            .setLabel('Venmo handle (optional)')
            .setRequired(false)
            .setStyle(TextInputStyle.Short);

          const zelle = new TextInputBuilder()
            .setCustomId('zelleInfo')
            .setLabel('Zelle info (optional)')
            .setRequired(false)
            .setStyle(TextInputStyle.Short);

          modal.addComponents(
            new ActionRowBuilder().addComponents(address1),
            new ActionRowBuilder().addComponents(city),
            new ActionRowBuilder().addComponents(postal),
            new ActionRowBuilder().addComponents(venmo),
            new ActionRowBuilder().addComponents(zelle)
          );

          await interaction.showModal(modal);
          return;
        }
        case 'suggest':
          await handleSuggest(interaction);
          break;
        case 'claim':
          await handleClaim(interaction);
          break;
        case 'receipt':
          await handleReceipt(interaction);
          break;
        case 'paid':
          await handlePaid(interaction);
          break;
        case 'status':
          await handleStatus(interaction);
          break;
        case 'profile':
          await handleProfile(interaction);
          break;
        case 'mark-paid':
          await handleMarkPaid(interaction, true);
          break;
        case 'mark-unpaid':
          await handleMarkPaid(interaction, false);
          break;
        default:
          break;
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'register_step_1') {
        await handleRegisterModal(interaction);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Config: GUILD_ID=${CONFIG.GUILD_ID || 'unset'} BDAY_CHANNEL_ID=${CONFIG.BDAY_CHANNEL_ID || 'unset'}`);
  cron.schedule(CONFIG.DAILY_CRON, dailyCheckGuarded, { timezone: CONFIG.TZ });
  await dailyCheckGuarded();
});

client.login(CONFIG.DISCORD_TOKEN);
