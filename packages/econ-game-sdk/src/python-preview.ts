import { EconGameHttpClient, encodePathSegment, type EconGameClientOptions } from './core.js';

/** Response shape from the Python/uv preview service, not the TypeScript product line. */
export type PythonPreviewHealthResponse = {
  status: string;
  postgres?: string | null;
  redis?: string | null;
};

export type PreviewPlayer = {
  id: string;
  username: string;
  created_at: string;
};

export type CreatePreviewPlayerInput = {
  username: string;
};

/**
 * Isolated client for python/services/api. Keep imports of this module explicit
 * so preview-only contracts cannot be mistaken for the TypeScript product API.
 */
export class PythonPreviewApiClient extends EconGameHttpClient {
  getHealth(): Promise<PythonPreviewHealthResponse> {
    return this.request({ method: 'GET', path: '/health' });
  }

  createPlayer(input: CreatePreviewPlayerInput): Promise<PreviewPlayer> {
    return this.request({ method: 'POST', path: '/players', body: input });
  }

  getPlayer(playerId: string): Promise<PreviewPlayer> {
    return this.request({ method: 'GET', path: `/players/${encodePathSegment(playerId)}` });
  }
}

export const createPythonPreviewApiClient = (options: EconGameClientOptions): PythonPreviewApiClient =>
  new PythonPreviewApiClient(options);
