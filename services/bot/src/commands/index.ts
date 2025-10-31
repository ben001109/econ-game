import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

import * as ping from './ping.js';
import * as ops from './ops.js';
import * as pos from './pos.js';
import * as kds from './kds.js';

export type SlashCommand = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (
    interaction: ChatInputCommandInteraction,
    t: (key: string, vars?: Record<string, string | number>) => string
  ) => Promise<void>;
};

export const commands: SlashCommand[] = [ping, ops, pos, kds];
