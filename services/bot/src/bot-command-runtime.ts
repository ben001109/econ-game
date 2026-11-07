import {
  BotCommandError,
  BotD02GameCommandClient,
  type BotD02CommandSuccess,
  type D02CommandValue,
} from './d02-game-command-client.js';
import { env } from './env.js';

export type BotOperationalCommandMapping = Readonly<{
  target: Readonly<{ saveId: string; commandType: string }>;
  expectedVersion: () => Promise<number>;
}>;

export class BotOperationalCommandRuntime {
  constructor(
    private readonly client: BotD02GameCommandClient,
    private readonly mappings: Readonly<Record<string, BotOperationalCommandMapping>>,
  ) {}

  async execute(
    operation: string,
    input: Readonly<{
      discordUserId: string;
      interactionId: string;
      payload: Readonly<Record<string, D02CommandValue>>;
    }>,
  ): Promise<BotD02CommandSuccess> {
    const mapping = this.mappings[operation];
    if (!mapping) throw new BotCommandError('BOT_COMMAND_MAPPING_NOT_CONFIGURED');
    return this.client.execute({
      discordUserId: input.discordUserId,
      interactionId: input.interactionId,
      target: mapping.target,
      expectedVersion: await mapping.expectedVersion(),
      payload: input.payload,
    });
  }
}

// No authority source currently defines POS/KDS D02 command types, save target,
// or version read model. The production map is deliberately empty and cannot
// fall back to the legacy compatibility surface.
export const productionBotCommandRuntime = new BotOperationalCommandRuntime(
  new BotD02GameCommandClient({
    apiBaseUrl: env.API_BASE_URL,
    serviceCredential: env.BOT_SERVICE_CREDENTIAL,
  }),
  Object.freeze({}),
);
