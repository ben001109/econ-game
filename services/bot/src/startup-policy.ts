export class BotStartupError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BotStartupError';
    this.code = code;
  }
}

export type LoginClient = Readonly<{
  login(token: string): Promise<unknown>;
}>;

/** Shared, side-effect-free startup policy used by the Discord runtime and tests. */
export async function startConnectedBot<T extends LoginClient>(
  client: T,
  token: string,
  installHandlers: (client: T) => void,
): Promise<T> {
  if (!token.trim()) throw new BotStartupError('DISCORD_BOT_TOKEN_NOT_CONFIGURED');
  installHandlers(client);
  await client.login(token);
  return client;
}
