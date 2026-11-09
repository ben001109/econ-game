import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

import * as ping from './ping.js';
import * as ops from './ops.js';
import * as game from './game.js';

export type SlashCommand = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (
    interaction: ChatInputCommandInteraction,
    t: (key: string, vars?: Record<string, string | number>) => string,
  ) => Promise<void>;
};

// Legacy POS/KDS modules remain in the source tree for migration history, but
// are not registered in the production Bot command surface.
export const commands: SlashCommand[] = [ping, ops, game];
