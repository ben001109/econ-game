import 'dotenv/config';
import * as Sentry from '@sentry/node';

type MonitoringState = {
  newRelic: boolean;
  sentry: boolean;
};

const globalState = globalThis as Record<string | symbol, unknown>;
const monitoringState: MonitoringState = { newRelic: false, sentry: false };

const legacyLicense = process.env.RELIC_API_KEY;
if (legacyLicense && !process.env.NEW_RELIC_LICENSE_KEY) {
  process.env.NEW_RELIC_LICENSE_KEY = legacyLicense;
}

if (process.env.RELIC_APP_NAME && !process.env.NEW_RELIC_APP_NAME) {
  process.env.NEW_RELIC_APP_NAME = process.env.RELIC_APP_NAME;
}

if (process.env.NEW_RELIC_LICENSE_KEY) {
  const newRelicFlag = Symbol.for('econGame.newRelicLoaded');
  if (!globalState[newRelicFlag]) {
    try {
      await import('newrelic');
      monitoringState.newRelic = true;
      globalState[newRelicFlag] = true;
    } catch (err) {
      if (process.env.NODE_ENV === 'production') {
        // eslint-disable-next-line no-console
        console.error('[newrelic] Failed to load agent module.', err);
      }
    }
  } else {
    monitoringState.newRelic = true;
  }
} else if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.warn('[newrelic] NEW_RELIC_LICENSE_KEY not set; agent disabled.');
}

const sentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '';
const sentryFlag = Symbol.for('econGame.sentryInitialized');
const sentryHooksFlag = Symbol.for('econGame.sentryProcessHooks');

function parseSampleRate(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

if (sentryDsn && !globalState[sentryFlag]) {
  const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
  const tracesSampleRate = parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);
  const profilesSampleRate = parseSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE, tracesSampleRate);
  Sentry.init({
    dsn: sentryDsn,
    environment,
    tracesSampleRate,
    profilesSampleRate,
    release: process.env.SENTRY_RELEASE || undefined,
  });
  monitoringState.sentry = true;
  globalState[sentryFlag] = true;
  process.env.SENTRY_ENABLED = 'true';
} else if (globalState[sentryFlag]) {
  monitoringState.sentry = true;
}

if (monitoringState.sentry && !globalState[sentryHooksFlag]) {
  const captureUnhandled = (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
    Sentry.captureException(error);
  };
  process.on('unhandledRejection', captureUnhandled);
  globalState[sentryHooksFlag] = true;
}

export { Sentry };
export const monitoring = monitoringState;
