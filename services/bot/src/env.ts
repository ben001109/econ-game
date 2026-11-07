import 'dotenv/config';

import { readBotRuntimeEnvironment } from './runtime-env.js';

export const env = readBotRuntimeEnvironment(process.env);
