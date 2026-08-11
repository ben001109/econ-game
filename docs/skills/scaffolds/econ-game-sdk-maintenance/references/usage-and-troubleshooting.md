# SDK Usage and Troubleshooting

Use this reference only with `econ-game-sdk-maintenance`. The authoritative current route list is [`docs/sdk/current-http-surface.md`](../../../../sdk/current-http-surface.md).

## Node/Fastify restaurant scaffold

```ts
import {
  EconGameApiError,
  createRestaurantApiClient,
} from '@econ-game/sdk';

const api = createRestaurantApiClient({
  baseUrl: apiBaseUrl,
  headers: requestHeaders,
});

try {
  const ticket = await api.startKdsTicket(ticketId);
  renderTicket(ticket);
} catch (error) {
  if (error instanceof EconGameApiError) {
    showRequestError(error.status, error.code);
    return;
  }
  throw error;
}
```

Do not retry the mutation automatically. The current service has not approved an idempotency contract for it.

## Python preview client

```ts
import { createPythonPreviewApiClient } from '@econ-game/sdk/python-preview';

const previewApi = createPythonPreviewApiClient({ baseUrl: previewApiBaseUrl });
const player = await previewApi.getPlayer(playerId);
```

Keep preview imports explicit. Do not pass `PreviewPlayer` or Python preview health data to a Node/Fastify consumer as though they were shared product types.

## Common failures

| Symptom | Likely cause | Safe response |
|---|---|---|
| `route surface changed` from `check:surface` | A route was added, removed, or renamed in a route source. | Update client method/types, expected route set, mock tests, package README, and SDK surface doc in one review. Do not silence the check. |
| `EconGameApiError` | Server returned a non-2xx response. | Inspect `status`, optional `code`, `path`, and `details`; present an approved consumer error. Do not guess a retry policy for mutations. |
| `ApiMoney` is a string in one response and a number in another | Prisma Decimal serialization is not yet a stable client contract. | Preserve `string | number`; do not add floating-point arithmetic or rounding rules to the SDK. Escalate contract semantics. |
| `bootstrapDemo` throws before sending a request | The confirmation token was omitted or incorrect. | Use `DEMO_BOOTSTRAP_CONFIRMATION` only in an explicitly disposable environment; do not weaken this guard. |
| Python and Node endpoints have similarly named health routes | The repo contains an experimental Python surface and a Node product scaffold. | Choose the explicit client module; do not create a catch-all client or shared persistence model. |
| `npm pack --dry-run` reports a global npm-cache permission error | A pre-existing global cache is not writable. | Use a temporary cache: `ECON_SDK_NPM_CACHE="$(mktemp -d)" && npm_config_cache="$ECON_SDK_NPM_CACHE" npm pack --dry-run`. Do not change ownership of another user's cache. |
| `npm run verify` cannot find `tsc` | Package dependencies are absent in a clean checkout. | Stop by default. Ask the Build/user owner before `npm ci`; after approval, run `npm ci --ignore-scripts --no-audit` then `npm run verify`. |
