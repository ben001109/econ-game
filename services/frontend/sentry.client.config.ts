import * as Sentry from '@sentry/nextjs';

function parseSampleRate(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

if (dsn && !Sentry.isInitialized()) {
  const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
  const tracesSampleRate = parseSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || process.env.SENTRY_TRACES_SAMPLE_RATE,
    0,
  );
  const profilesSampleRate = parseSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_PROFILES_SAMPLE_RATE || process.env.SENTRY_PROFILES_SAMPLE_RATE,
    tracesSampleRate,
  );
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate,
    profilesSampleRate,
    debug: process.env.NODE_ENV === 'development',
  });
}
