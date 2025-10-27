import 'dotenv/config';

const legacyLicense = process.env.RELIC_API_KEY;
if (legacyLicense && !process.env.NEW_RELIC_LICENSE_KEY) {
  process.env.NEW_RELIC_LICENSE_KEY = legacyLicense;
}

if (process.env.RELIC_APP_NAME && !process.env.NEW_RELIC_APP_NAME) {
  process.env.NEW_RELIC_APP_NAME = process.env.RELIC_APP_NAME;
}

if (process.env.NEW_RELIC_LICENSE_KEY) {
  try {
    await import('newrelic');
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      // eslint-disable-next-line no-console
      console.error('[newrelic] Failed to load agent module.', err);
    }
  }
} else if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.warn('[newrelic] NEW_RELIC_LICENSE_KEY not set; agent disabled.');
}
