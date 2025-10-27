import 'dotenv/config';

export const env = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  DATABASE_URL: process.env.DATABASE_URL || '',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  NEW_RELIC_APP_NAME: process.env.NEW_RELIC_APP_NAME || process.env.RELIC_APP_NAME || 'econ-game-api',
  NEW_RELIC_LICENSE_KEY: process.env.NEW_RELIC_LICENSE_KEY || process.env.RELIC_API_KEY || '',
  SENTRY_DSN: process.env.SENTRY_DSN || '',
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
};

if (!env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn('[env] DATABASE_URL not set.');
}
