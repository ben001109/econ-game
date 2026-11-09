import 'dotenv/config';

import { readApiRuntimeEnvironment } from './runtime-env.js';

export const env = readApiRuntimeEnvironment(process.env);
