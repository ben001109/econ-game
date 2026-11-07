const SENSITIVE_KEY =
  /(?:authorization|cookie|token|secret|password|credential|apikey|dsn|databaseurl|proof|email|discorduserid|clerkuserid)/i;
const REDACTED = '[REDACTED]';

export function redactTelemetryValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => redactTelemetryValue(entry, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactTelemetryValue(entry, depth + 1);
  }
  return output;
}

export function safeTelemetryRoute(route: string | undefined, fallbackUrl: string): string {
  if (route) return route;
  const queryStart = fallbackUrl.indexOf('?');
  return queryStart === -1 ? fallbackUrl : fallbackUrl.slice(0, queryStart);
}
