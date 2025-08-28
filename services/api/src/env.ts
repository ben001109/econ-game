import 'dotenv/config';

export const env = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  DATABASE_URL: process.env.DATABASE_URL || '',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
};

if (!env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn('[env] DATABASE_URL not set.');
}

