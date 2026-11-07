import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

import { env } from './env.js';
import { monitoring, Sentry, registerProcessLogging } from './instrumentation.js';
import { logger } from './logger.js';
import {
  createProductionApiComposition,
  productionIdentityConfigurationFromEnvironment,
  type ProductionApiDatabase,
} from './production-api-composition.js';
import { redactTelemetryValue, safeTelemetryRoute } from './security/redaction.js';

async function loadProductionDatabase(): Promise<ProductionApiDatabase> {
  const prismaModule = (await import('@prisma/client')) as unknown as Readonly<{
    PrismaClient: new () => ProductionApiDatabase;
  }>;
  return new prismaModule.PrismaClient();
}

const prisma = await loadProductionDatabase();
const app = createProductionApiComposition({
  logger,
  database: prisma,
  identityConfiguration: productionIdentityConfigurationFromEnvironment(env),
});

registerProcessLogging(logger);

if (monitoring.sentry) {
  app.addHook('onError', async (request, _reply, _error) => {
    const configuredRoute =
      typeof request.routeOptions?.url === 'string' && request.routeOptions.url.length > 0
        ? request.routeOptions.url
        : undefined;
    const route = safeTelemetryRoute(configuredRoute, request.url);
    Sentry.withScope((scope) => {
      scope.setTag('service', 'api');
      scope.setTag('method', request.method);
      scope.setTag('route', route);
      scope.setExtra('requestId', request.id);
      scope.setExtra('params', redactTelemetryValue(request.params));
      scope.setExtra('query', redactTelemetryValue(request.query));
      scope.setExtra('body', redactTelemetryValue(request.body));
      Sentry.captureException(new Error('API_REQUEST_FAILED'));
    });
  });
}

await app.register(cors, { origin: true });

await app.register(swagger, {
  openapi: {
    info: { title: 'Restaurant API', version: '0.1.0' },
  },
});
await app.register(swaggerUI, { routePrefix: '/docs' });

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  app.log.info(`API listening on :${env.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
