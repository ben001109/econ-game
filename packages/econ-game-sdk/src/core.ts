export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type EconGameClientOptions = {
  /** Absolute service URL, optionally including a stable path prefix. */
  baseUrl: string;
  /** Supply a test double or runtime-specific fetch implementation when needed. */
  fetch?: FetchLike;
  /** Headers applied to every request. Do not place secrets in source code. */
  headers?: HeadersInit;
};

export type EconGameApiErrorInit = {
  status: number;
  statusText: string;
  method: string;
  path: string;
  details: unknown;
};

export type EconGameHttpResponse<T> = Readonly<{
  status: number;
  body: T;
}>;

/** An HTTP response rejected by an Econ Game service. */
export class EconGameApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly errorVersion: string | undefined;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;

  constructor(init: EconGameApiErrorInit) {
    const body = asRecord(init.details);
    const commandError = asRecord(body?.error);
    const code =
      typeof commandError?.code === 'string'
        ? commandError.code
        : typeof body?.code === 'string'
          ? body.code
          : undefined;
    const detail = typeof body?.detail === 'string' ? body.detail : undefined;
    const message =
      typeof body?.message === 'string' ? body.message : (detail ?? code ?? init.statusText);
    super(`${init.method} ${init.path} failed (${init.status}): ${message}`);
    this.name = 'EconGameApiError';
    this.status = init.status;
    this.code = code;
    this.errorVersion =
      typeof commandError?.version === 'string' ? commandError.version : undefined;
    this.details = init.details;
    this.method = init.method;
    this.path = init.path;
  }
}

export const isEconGameApiError = (value: unknown): value is EconGameApiError =>
  value instanceof EconGameApiError;

type RequestOptions = {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: HeadersInit;
};

/**
 * Shared transport for all current service surfaces. It deliberately does not
 * load environment files, retry mutations, infer auth, or transform money.
 */
export class EconGameHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchLike;
  private readonly defaultHeaders: Headers;

  constructor(options: EconGameClientOptions) {
    if (!options.baseUrl.trim()) {
      throw new TypeError('baseUrl must be a non-empty absolute URL.');
    }

    const parsed = new URL(options.baseUrl);
    this.baseUrl = parsed.toString().replace(/\/+$/, '');
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = new Headers(options.headers);
  }

  protected async request<T>(options: RequestOptions): Promise<T> {
    return (await this.requestWithStatus<T>(options)).body;
  }

  protected async requestWithStatus<T>(options: RequestOptions): Promise<EconGameHttpResponse<T>> {
    const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
    const headers = new Headers(this.defaultHeaders);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));

    let body: string | undefined;
    if (options.body !== undefined) {
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method: options.method,
      headers,
      body,
    });
    const payload = await decodeBody(response);

    if (!response.ok) {
      throw new EconGameApiError({
        status: response.status,
        statusText: response.statusText,
        method: options.method,
        path,
        details: payload,
      });
    }

    return Object.freeze({ status: response.status, body: payload as T });
  }
}

export const encodePathSegment = (value: string): string => encodeURIComponent(value);

async function decodeBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
