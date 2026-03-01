import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { CONFIG } from './config.js';

const commands = [
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your birthday and mailing address')
    .addStringOption((opt) =>
      opt.setName('birthday')
        .setDescription('YYYY-MM-DD')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Suggest a gift (thread only)')
    .addStringOption((opt) =>
      opt.setName('url')
        .setDescription('Gift link')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Start a vote with all proposed gift ideas (thread only)'),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim purchaser for this cycle (thread only)'),
  new SlashCommandBuilder()
    .setName('receipt')
    .setDescription('Post receipt total (purchaser only, thread only)')
    .addNumberOption((opt) =>
      opt.setName('total')
        .setDescription('Receipt total in USD')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('paid')
    .setDescription('Mark yourself paid (thread only)'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show cycle status (thread only)'),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show your stored birthday and payment info'),
  new SlashCommandBuilder()
    .setName('registered')
    .setDescription('List all registered users and birthdays'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a registered user')
    .addUserOption((opt) =>
      opt.setName('user')
        .setDescription('User to remove from registrations')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('mark-paid')
    .setDescription('Purchaser override: mark a user paid')
    .addUserOption((opt) =>
      opt.setName('user')
        .setDescription('User to mark paid')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('note')
        .setDescription('Optional note')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('mark-unpaid')
    .setDescription('Purchaser override: mark a user unpaid')
    .addUserOption((opt) =>
      opt.setName('user')
        .setDescription('User to mark unpaid')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('note')
        .setDescription('Optional note')
        .setRequired(false)
    )
].map((c) => c.toJSON());

if (!process.env.CLIENT_ID) {
  throw new Error('Missing required env var: CLIENT_ID');
}

const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);

async function main() {
  if (CONFIG.GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });
    console.log('Registered guild commands.');
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Registered global commands.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
