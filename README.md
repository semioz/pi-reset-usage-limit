# Pi Reset Usage Limit

A user-global Pi extension that adds `/reset-usage-limit`. The command consumes one real OpenAI Codex usage-limit reset credit for the account authenticated through Pi's `openai-codex` provider.

## Install

```bash
pi install npm:pi-reset-usage-limit
```

## Usage

Start or reload Pi, then run:

```text
/reset-usage-limit
```

The command checks how many reset credits are available, displays the selected credit's title and expiration when available, and asks for confirmation. One invocation consumes at most one credit. Codex may allow a voluntary reset even when `applicable_available_count` is zero, so redemption is gated by `available_count`, matching the official Codex UI.

## Safety

- Uses Pi's refreshed OAuth access through `ctx.modelRegistry`; it does not read or display `auth.json`.
- Requires interactive confirmation before consuming a credit.
- Sends one consume request with a UUID redemption request ID, used idempotently by Codex.
- Never logs access tokens or ChatGPT account IDs.
- Tests inject the network layer and never consume a real credit.
- Live verification is limited to read-only credit discovery.

## Compatibility

The extension mirrors Codex's current `/usage` reset capability and uses these ChatGPT Codex account endpoints:

- `GET /backend-api/wham/usage`
- `GET /backend-api/wham/rate-limit-reset-credits`
- `POST /backend-api/wham/rate-limit-reset-credits/consume`

The backend is not a stable public API, so a future Codex change may require updating the isolated request/parsing functions in `core.ts`.
