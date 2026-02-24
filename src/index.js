import {
  Client,
  GatewayIntentBits,
  Partials,
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

function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function parseBirthday(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map((n) => parseInt(n, 10));
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function parseDateOnly(str) {
  const [y, m, d] = str.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
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
      await msg.edit(content);
      return;
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

async function handleRegister(interaction) {
  const birthdayStr = interaction.options.getString('birthday');
  const date = parseBirthday(birthdayStr);
  if (!date) {
    await interaction.reply({ content: 'Invalid birthday format. Use YYYY-MM-DD.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`register1:${birthdayStr}`)
    .setTitle('Birthday Registration (1/2)');

  const fullName = new TextInputBuilder()
    .setCustomId('fullName')
    .setLabel('Full name (optional)')
    .setRequired(false)
    .setStyle(TextInputStyle.Short);

  const address1 = new TextInputBuilder()
    .setCustomId('address_line1')
    .setLabel('Address Line 1')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  const address2 = new TextInputBuilder()
    .setCustomId('address_line2')
    .setLabel('Address Line 2 (optional)')
    .setRequired(false)
    .setStyle(TextInputStyle.Short);

  const city = new TextInputBuilder()
    .setCustomId('city')
    .setLabel('City')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  const state = new TextInputBuilder()
    .setCustomId('state')
    .setLabel('State')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  modal.addComponents(
    new ActionRowBuilder().addComponents(fullName),
    new ActionRowBuilder().addComponents(address1),
    new ActionRowBuilder().addComponents(address2),
    new ActionRowBuilder().addComponents(city),
    new ActionRowBuilder().addComponents(state)
  );

  await interaction.showModal(modal);
}

async function handleRegisterModalStep1(interaction) {
  const [, birthdayStr] = interaction.customId.split(':');
  const date = parseBirthday(birthdayStr);
  if (!date) {
    await interaction.reply({ content: 'Invalid birthday format.', ephemeral: true });
    return;
  }

  const partial = {
    name: interaction.fields.getTextInputValue('fullName') || null,
    address_line1: interaction.fields.getTextInputValue('address_line1'),
    address_line2: interaction.fields.getTextInputValue('address_line2') || null,
    city: interaction.fields.getTextInputValue('city'),
    state: interaction.fields.getTextInputValue('state')
  };

  await withClient(async (db) => {
    await db.query(
      `INSERT INTO registration_sessions (discord_user_id, birthday, data_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET birthday = EXCLUDED.birthday, data_json = EXCLUDED.data_json, created_at = NOW()`,
      [interaction.user.id, birthdayStr, JSON.stringify(partial)]
    );
  });

  const modal = new ModalBuilder()
    .setCustomId(`register2:${birthdayStr}`)
    .setTitle('Birthday Registration (2/2)');

  const postal = new TextInputBuilder()
    .setCustomId('postalCode')
    .setLabel('Postal Code')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  const country = new TextInputBuilder()
    .setCustomId('country')
    .setLabel('Country (default US)')
    .setRequired(false)
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
    new ActionRowBuilder().addComponents(postal),
    new ActionRowBuilder().addComponents(country),
    new ActionRowBuilder().addComponents(venmo),
    new ActionRowBuilder().addComponents(zelle)
  );

  await interaction.showModal(modal);
}

async function handleRegisterModalStep2(interaction) {
  const [, birthdayStr] = interaction.customId.split(':');
  const date = parseBirthday(birthdayStr);
  if (!date) {
    await interaction.reply({ content: 'Invalid birthday format.', ephemeral: true });
    return;
  }

  const session = await withClient(async (db) => {
    const res = await db.query('SELECT * FROM registration_sessions WHERE discord_user_id = $1', [interaction.user.id]);
    return res.rows[0];
  });
  if (!session) {
    await interaction.reply({ content: 'Registration session expired. Please run /register again.', ephemeral: true });
    return;
  }

  const partial = session.data_json || {};
  const address = {
    line1: partial.address_line1,
    line2: partial.address_line2 || null,
    city: partial.city,
    state: partial.state,
    postalCode: interaction.fields.getTextInputValue('postalCode'),
    country: interaction.fields.getTextInputValue('country') || 'US'
  };

  const encrypted = encryptAddress(address);
  const name = partial.name || null;
  const venmo = interaction.fields.getTextInputValue('venmoHandle') || null;
  const zelle = interaction.fields.getTextInputValue('zelleInfo') || null;

  await withClient(async (db) => {
    await db.query(
      `INSERT INTO users (discord_user_id, birthday, venmo, zelle, name, address_ciphertext, address_iv, address_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET birthday = EXCLUDED.birthday, venmo = EXCLUDED.venmo, zelle = EXCLUDED.zelle, name = EXCLUDED.name,
       address_ciphertext = EXCLUDED.address_ciphertext, address_iv = EXCLUDED.address_iv, address_version = EXCLUDED.address_version,
       updated_at = NOW()`,
      [interaction.user.id, birthdayStr, venmo, zelle, name, encrypted.ciphertext, encrypted.iv, encrypted.version]
    );
    await db.query('DELETE FROM registration_sessions WHERE discord_user_id = $1', [interaction.user.id]);
  });

  await interaction.reply({ content: 'Registration saved.', ephemeral: true });
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
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', ephemeral: true });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', ephemeral: true });
    return;
  }
  if (interaction.user.id === cycle.birthday_discord_user_id) {
    await interaction.reply({ content: 'Birthday person cannot suggest.', ephemeral: true });
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
    await interaction.reply({ content: 'Suggestion limit reached (3 per user).', ephemeral: true });
    return;
  }
  if (latest) {
    const diff = Date.now() - new Date(latest).getTime();
    if (diff < 60 * 1000) {
      await interaction.reply({ content: 'Please wait 1 minute between suggestions.', ephemeral: true });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });
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
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', ephemeral: true });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', ephemeral: true });
    return;
  }
  if (!cycle.winner_suggestion_id) {
    await interaction.reply({ content: 'Voting is not closed yet.', ephemeral: true });
    return;
  }
  if (interaction.user.id === cycle.birthday_discord_user_id) {
    await interaction.reply({ content: 'Birthday person cannot claim.', ephemeral: true });
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
    await interaction.reply({ content: 'Purchaser already claimed.', ephemeral: true });
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

  await interaction.reply({ content: 'You are the purchaser. Check your DMs for the address.', ephemeral: true });
}

async function handleReceipt(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', ephemeral: true });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== cycle.purchaser_discord_user_id) {
    await interaction.reply({ content: 'Only the purchaser can post the receipt.', ephemeral: true });
    return;
  }

  const total = interaction.options.getNumber('total');
  if (!total || total <= 0) {
    await interaction.reply({ content: 'Invalid receipt total.', ephemeral: true });
    return;
  }

  const { channel } = await getGuildAndChannel();
  if (!channel) {
    await interaction.reply({ content: 'Channel not found.', ephemeral: true });
    return;
  }
  const participants = await getParticipantsForChannel(channel, cycle.birthday_discord_user_id);
  const count = participants.length;
  if (count === 0) {
    await interaction.reply({ content: 'No participants found for split.', ephemeral: true });
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
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', ephemeral: true });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle || !cycle.participants_snapshot_json) {
    await interaction.reply({ content: 'Receipt not posted yet.', ephemeral: true });
    return;
  }
  const participants = cycle.participants_snapshot_json || [];
  if (!participants.includes(interaction.user.id)) {
    await interaction.reply({ content: 'You are not in the participant list for this cycle.', ephemeral: true });
    return;
  }

  await updatePayment(interaction.channel, cycle, interaction.user.id, new Date().toISOString(), false, null);
  await interaction.reply({ content: 'Marked as paid.', ephemeral: true });
}

async function handleStatus(interaction) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', ephemeral: true });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', ephemeral: true });
    return;
  }
  const purchaser = cycle.purchaser_discord_user_id ? `<@${cycle.purchaser_discord_user_id}>` : 'Unclaimed';
  const winner = cycle.winner_suggestion_id ? 'Selected' : 'Pending';
  const receipt = cycle.receipt_total ? `$${Number(cycle.receipt_total).toFixed(2)}` : 'Not posted';
  await interaction.reply({
    content: `Status:\nWinner: ${winner}\nPurchaser: ${purchaser}\nReceipt: ${receipt}`,
    ephemeral: true
  });
}

async function handleMarkPaid(interaction, isPaid) {
  if (!ensureThreadOnly(interaction)) {
    await interaction.reply({ content: 'Please run this command inside a birthday thread.', ephemeral: true });
    return;
  }
  const cycle = await getCycleByThread(interaction.channelId);
  if (!cycle) {
    await interaction.reply({ content: 'No active cycle found for this thread.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== cycle.purchaser_discord_user_id) {
    await interaction.reply({ content: 'Only the purchaser can use this.', ephemeral: true });
    return;
  }

  const target = interaction.options.getUser('user');
  const note = interaction.options.getString('note');

  await updatePayment(interaction.channel, cycle, target.id, isPaid ? new Date().toISOString() : null, true, note);

  await interaction.reply({ content: `${target.username} marked as ${isPaid ? 'paid' : 'unpaid'}.`, ephemeral: true });
  await interaction.channel.send(`Audit: ${interaction.user.username} marked ${target.username} as ${isPaid ? 'paid' : 'unpaid'}${note ? ` (${note})` : ''}.`);
}

async function dailyCheck() {
  const { guild, channel } = await getGuildAndChannel();
  if (!guild || !channel) return;
  await ensureCircle(guild.id);

  const today = new Date();
  const todayStr = toLocalDateString(today);

  // Create threads at T-21
  const users = await withClient(async (db) => {
    const res = await db.query('SELECT * FROM users');
    return res.rows;
  });

  for (const user of users) {
    const raw = user.birthday.toISOString ? toLocalDateString(user.birthday) : String(user.birthday).slice(0, 10);
    const userBday = parseDateOnly(raw);
    const bday = new Date(today.getFullYear(), userBday.getMonth(), userBday.getDate());
    const triggerDate = addDays(bday, -21);
    if (toLocalDateString(triggerDate) !== todayStr) continue;

    const existing = await withClient(async (db) => {
      const res = await db.query(
        'SELECT * FROM cycles WHERE guild_id = $1 AND birthday_discord_user_id = $2 AND birthday_date = $3',
        [guild.id, user.discord_user_id, toLocalDateString(bday)]
      );
      return res.rows[0];
    });

    if (existing && existing.thread_id) continue;

    const nameBase = user.name || (await guild.members.fetch(user.discord_user_id).catch(() => null))?.displayName || 'member';
    const threadName = `${nameBase.toLowerCase().replace(/\s+/g, '-')}-${toLocalDateString(bday)}`;

    const message = await channel.send(`Birthday cycle starting for <@${user.discord_user_id}>. Thread created.`);
    const thread = await message.startThread({ name: threadName, autoArchiveDuration: 1440 });

    await thread.permissionOverwrites.edit(user.discord_user_id, { ViewChannel: false });

    await thread.send(
      'Welcome! Flow: suggest gifts with /suggest, vote with 👍, winner picked at T-5. After winner: /claim, then purchaser posts /receipt. Participants use /paid.'
    );

    await withClient(async (db) => {
      await db.query(
        `INSERT INTO cycles (guild_id, birthday_discord_user_id, birthday_date, thread_id, status)
         VALUES ($1, $2, $3, $4, 'open')
         ON CONFLICT (guild_id, birthday_discord_user_id, birthday_date)
         DO UPDATE SET thread_id = EXCLUDED.thread_id, updated_at = NOW()`,
        [guild.id, user.discord_user_id, toLocalDateString(bday), thread.id]
      );
    });
  }

  // Close voting at T-5
  const openCycles = await withClient(async (db) => {
    const res = await db.query("SELECT * FROM cycles WHERE status = 'open' AND thread_id IS NOT NULL");
    return res.rows;
  });

  for (const cycle of openCycles) {
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
  }

  // 7-day reminders after receipt
  const reminderCycles = await withClient(async (db) => {
    const res = await db.query(
      "SELECT * FROM cycles WHERE receipt_at IS NOT NULL AND reminder_sent_at IS NULL AND participants_snapshot_json IS NOT NULL"
    );
    return res.rows;
  });

  for (const cycle of reminderCycles) {
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
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) continue;
        await user.send(
          `Reminder: Please pay $${split.toFixed(2)} for <@${cycle.birthday_discord_user_id}> and then type /paid in the thread.`
        ).catch(() => null);
      }
    }

    await withClient(async (db) => {
      await db.query('UPDATE cycles SET reminder_sent_at = NOW() WHERE id = $1', [cycle.id]);
    });
  }

  // Completion & archive
  const receiptCycles = await withClient(async (db) => {
    const res = await db.query(
      "SELECT * FROM cycles WHERE receipt_at IS NOT NULL AND participants_snapshot_json IS NOT NULL AND archived_at IS NULL"
    );
    return res.rows;
  });

  for (const cycle of receiptCycles) {
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
      const delDate = addDays(new Date(cycle.archived_at), CONFIG.AUTO_DELETE_ARCHIVED_DAYS);
      if (toLocalDateString(delDate) !== todayStr) continue;
      const thread = await guild.channels.fetch(cycle.thread_id).catch(() => null);
      if (thread) {
        await thread.delete().catch(() => null);
      }
    }
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'register':
          await handleRegister(interaction);
          break;
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
      if (interaction.customId.startsWith('register1:')) {
        await handleRegisterModalStep1(interaction);
      } else if (interaction.customId.startsWith('register2:')) {
        await handleRegisterModalStep2(interaction);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => null);
    }
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  cron.schedule(CONFIG.DAILY_CRON, dailyCheck, { timezone: CONFIG.TZ });
  await dailyCheck();
});

client.login(CONFIG.DISCORD_TOKEN);
