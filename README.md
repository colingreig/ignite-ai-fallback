# @ignite/ai-fallback

Fetch-based LLM provider fallback with **zero runtime dependencies**.

Runs identically in all four runtimes used across Ignite projects:
- **Next.js / Node.js** (Node 18+)
- **Cloudflare Workers** (no Node-specific imports)
- **Supabase Deno edge functions** (reads `Deno.env.get` automatically)
- **Plain `.mjs` Node scripts**

No `@anthropic-ai/sdk`, no `openai`, no `@ai-sdk/*`. Just `fetch` + TypeScript.

---

## Install

```bash
# npm / pnpm / bun
npm install @ignite/ai-fallback

# Deno (JSR — pending scope claim, see below)
import { runWithFallback } from 'jsr:@ignite/ai-fallback';
```

## Quick start

```ts
import { runWithFallback } from '@ignite/ai-fallback';

const result = await runWithFallback(
  [
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { provider: 'openai',    model: 'gpt-4o' },
    { provider: 'zai-glm',  model: 'glm-4-plus' },
  ],
  {
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Summarise the key risks of LLM monoculture.' }],
    maxTokens: 512,
  },
);

console.log(result.text);
// → "The key risks include…"

console.log(result.provider, result.model);
// → "anthropic"  "claude-sonnet-4-6"  (or whichever step succeeded first)
```

---

## Runtime support

| Runtime | Env var lookup | fetch | Status |
|---|---|---|---|
| Node 18+ | `process.env` | `globalThis.fetch` | Supported |
| Cloudflare Workers | `process.env` (shimmed) | native | Supported |
| Deno | `Deno.env.get()` | native | Supported |
| Bun | `process.env` | native | Supported |

---

## Providers

| Provider | Key env var | Default base URL | CF Gateway slug |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | `anthropic` |
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `openai` |
| `google` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com` | `google-ai-studio` |
| `zai-glm` | `ZAI_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` | *(bypasses gateway)* |

zai-glm is OpenAI-compatible and always calls its direct base URL — Cloudflare AI Gateway has no native z.ai provider.

---

## Cloudflare AI Gateway

When `opts.gatewayBase` is set (typically from `CF_AI_GATEWAY_BASE`), supported providers route through the gateway:

```
{gatewayBase}/{providerSlug}/...
```

```ts
const result = await runWithFallback(chain, request, {
  gatewayBase: process.env.CF_AI_GATEWAY_BASE,
  // e.g. https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}
});
```

zai-glm ignores `gatewayBase` and always calls `https://open.bigmodel.cn/api/paas/v4` directly.

---

## API key resolution

Keys are resolved in this order:

1. `opts.keys[provider]` — explicit override per-call
2. Environment variable for the provider (see table above)
3. If neither resolves → step is **skipped** (non-fatal; listed in the thrown `AggregateError` if all steps fail)

---

## Chain advancement rules

| Situation | Behavior |
|---|---|
| API key absent | Skip step (non-fatal) |
| HTTP 429 | Advance to next step |
| HTTP 5xx (incl. 529 overloaded) | Advance to next step |
| Network error (fetch throws) | Advance to next step |
| `AbortError` | Re-throw immediately |
| HTTP 4xx (except 429) | Throw immediately (misconfiguration) |
| All steps fail/skip | Throw `AggregateError` with per-step reasons |

---

## JSON Schema / structured output

Pass a JSON Schema object as `request.jsonSchema` and each adapter translates it to the provider's native mechanism:

- **Anthropic** — tool-calling (`json_output` tool, `tool_choice: tool`)
- **OpenAI / zai-glm** — `response_format: { type: 'json_schema', ... }`
- **Google** — `generationConfig.responseMimeType: 'application/json'` + `responseSchema`

`result.text` will contain the JSON string in all cases.

---

## How to add a new provider

Adding a provider is a one-file change:

1. **Create** `src/adapters/myprovider.ts` — implement `buildMyProviderRequest` and `parseMyProviderResponse` following the same shape as the existing adapters.

2. **Register** it in `src/fallback.ts` — add to `Provider`, `PROVIDER_ENV_KEYS`, `PROVIDER_BASE`, and `ADAPTERS`. If it routes through CF AI Gateway, add a slug to `GATEWAY_SLUGS`.

3. **Export** the new adapter functions from `src/index.ts`.

4. Add test cases to `test/adapters.test.js`.

No other files need to change. The chain is pure data — callers just pass `{ provider: 'myprovider', model: '...' }` as a step.

---

## Development

```bash
npm install          # installs typescript devDep
npm run build        # tsc → dist/
npm run test         # node --test test/*.js  (requires build first)
npm run test:all     # build + test in one command
```

---

## JSR publishing (pending)

`jsr.json` is ready. Publishing requires:
- Claiming the `@ignite` scope on [jsr.io](https://jsr.io) (Anthropic account or org)
- Running `npx jsr publish` — do **not** run this until the scope is confirmed

Exports point to `src/index.ts` (JSR compiles TypeScript natively).
