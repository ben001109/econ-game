import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import * as ping from './ping.js';
import * as init from './init.js';

export type SlashCommand = {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction, t: (k: string) => string) => Promise<void>;
};

export const commands: SlashCommand[] = [ping, init];

