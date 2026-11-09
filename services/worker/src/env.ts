import 'dotenv/config';

import { readWorkerRuntimeEnvironment } from './runtime-env.js';

export const env = readWorkerRuntimeEnvironment(process.env, process.pid);
