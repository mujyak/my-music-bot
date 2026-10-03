// modules/kojin/interactions.js
import { KOJIN_REPLIES } from './commands.js';

export async function dispatchKojinInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const def = KOJIN_REPLIES[interaction.commandName];
  if (!def) return false;

  await interaction.reply({
    content: String(def.content ?? ''),
    ephemeral: !!def.ephemeral,
    allowedMentions: { parse: [] }, // メンション暴発防止
  });

  return true;
}
