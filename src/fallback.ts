import type {
  ProviderStep,
  ChatRequest,
  ChatResult,
  FallbackOptions,
  Provider,
} from './types.js';
import { readEnv } from './env.js';
import { buildAnthropicRequest, parseAnthropicResponse } from './adapters/anthropic.js';
import { buildOpenAIRequest, parseOpenAIResponse } from './adapters/openai.js';
import { buildGoogleRequest, parseGoogleResponse } from './adapters/google.js';

// ---------------------------------------------------------------------------
// Provider constants
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'zai-glm': 'ZAI_API_KEY',
};

/**
 * Direct (non-gateway) base URLs per provider.
 *
 * zai-glm: https://api.z.ai/api/paas/v4 — z.ai's OpenAI-compatible PAYG endpoint
 * (Bearer auth, ZAI_API_KEY). Requires a FUNDED z.ai pay-as-you-go account/key.
 * Override with the ZAI_BASE_URL env var if you move endpoints, e.g. the Coding
 * Plan path https://api.z.ai/api/coding/paas/v4 (subscription quota, but z.ai's
 * TOS scopes that plan to coding tools, not app backends). Do NOT use
 * open.bigmodel.cn (Zhipu China, separate account → error 1113 with a z.ai key).
 */
const PROVIDER_BASE: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com',
  'zai-glm': 'https://api.z.ai/api/paas/v4',
};

/**
 * CF AI Gateway provider slugs used to build the routed URL:
 *   {gatewayBase}/{slug}/...
 *
 * zai-glm is intentionally absent — CF has no native z.ai provider,
 * so zai-glm always calls its direct base URL regardless of gatewayBase.
 */
const GATEWAY_SLUGS: Partial<Record<Provider, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-ai-studio',
};

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

type BuildFn = (
  req: ChatRequest,
  model: string,
  key: string,
  base: string,
) => { url: string; init: RequestInit };

type ParseFn = (data: unknown, provider: Provider, model: string) => ChatResult;

const ADAPTERS: Record<Provider, { build: BuildFn; parse: ParseFn }> = {
  anthropic: { build: buildAnthropicRequest, parse: parseAnthropicResponse },
  openai: { build: buildOpenAIRequest, parse: parseOpenAIResponse },
  google: { build: buildGoogleRequest, parse: parseGoogleResponse },
  // zai-glm is OpenAI-compatible; reuse the same adapter, only base URL differs
  'zai-glm': { build: buildOpenAIRequest, parse: parseOpenAIResponse },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveKey(
  provider: Provider,
  overrides?: Partial<Record<Provider, string>>,
): string | undefined {
  return overrides?.[provider] ?? readEnv(PROVIDER_ENV_KEYS[provider]);
}

function getBaseUrl(provider: Provider, gatewayBase?: string): string {
  // zai-glm always bypasses the CF AI Gateway; base URL overridable via ZAI_BASE_URL
  // (e.g. to switch between the PAYG and Coding Plan endpoints without a code change).
  if (provider === 'zai-glm') {
    return readEnv('ZAI_BASE_URL') ?? PROVIDER_BASE['zai-glm'];
  }
  if (!gatewayBase) {
    return PROVIDER_BASE[provider];
  }
  const slug = GATEWAY_SLUGS[provider];
  return slug ? `${gatewayBase}/${slug}` : PROVIDER_BASE[provider];
}

/**
 * Returns true for HTTP status codes that warrant trying the next provider:
 *   - 429  Too Many Requests / rate limit
 *   - 5xx  Server errors (overload, maintenance, transient failures)
 *
 * 4xx errors other than 429 (bad request, invalid auth, etc.) are NOT retryable
 * and are propagated immediately so the caller can fix the underlying issue.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface StepFailure {
  step: ProviderStep;
  reason: string;
}

/**
 * Runs a chain of LLM provider steps in order, returning the first success.
 *
 * Advancement rules (when does it move to the next step?):
 *   - Missing API key        → silently skip (non-fatal, logged in AggregateError)
 *   - Any HTTP error (4xx/5xx) → advance to next step (revoked key, stale model,
 *                                or overload on one provider routes to the next)
 *   - Network / fetch error  → advance to next step
 *   - AbortError             → re-throw immediately (caller cancelled)
 *   - All steps fail/skip    → throw AggregateError listing every step's reason
 *
 * @example
 * ```ts
 * const result = await runWithFallback(
 *   [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
 *     { provider: 'openai',    model: 'gpt-4o' },
 *     { provider: 'zai-glm',  model: 'glm-4-plus' },
 *   ],
 *   { messages: [{ role: 'user', content: 'Hello!' }] },
 *   { gatewayBase: process.env.CF_AI_GATEWAY_BASE },
 * );
 * console.log(result.text, result.provider);
 * ```
 */
export async function runWithFallback(
  chain: ProviderStep[],
  request: ChatRequest,
  opts?: FallbackOptions,
): Promise<ChatResult> {
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const failures: StepFailure[] = [];

  for (const step of chain) {
    const apiKey = resolveKey(step.provider, opts?.keys);

    if (!apiKey) {
      failures.push({
        step,
        reason: `API key not configured (env: ${PROVIDER_ENV_KEYS[step.provider]}) — step skipped`,
      });
      continue;
    }

    const baseUrl = getBaseUrl(step.provider, opts?.gatewayBase);
    const { build, parse } = ADAPTERS[step.provider];
    const { url, init } = build(request, step.model, apiKey, baseUrl);

    // Merge caller-supplied extra headers (e.g. CF AI Gateway metadata tags)
    // UNDER the adapter's own headers, so adapter auth/content-type always win.
    const headers = opts?.extraHeaders
      ? { ...opts.extraHeaders, ...(init.headers as Record<string, string>) }
      : init.headers;

    let response: Response;
    try {
      response = await fetchFn(url, { ...init, headers, signal: opts?.signal });
    } catch (err) {
      // Re-throw cancellation immediately
      if (err instanceof Error && err.name === 'AbortError') throw err;
      failures.push({
        step,
        reason: `Network error: ${String(err)}`,
      });
      continue;
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => '(unreadable body)');
      }

      // Advance on ANY HTTP error. This is a resilience chain: a revoked key
      // (401), stale model (404), or per-provider bad-request (400) on one
      // provider should route to the next, not kill the whole request. A
      // request malformed for every provider simply exhausts the chain and
      // surfaces all reasons via the AggregateError below. isRetryableStatus
      // only annotates the reason (transient vs config) for debuggability.
      const kind = isRetryableStatus(response.status) ? 'transient' : 'config';
      failures.push({
        step,
        reason: `HTTP ${response.status} (${kind}): ${JSON.stringify(body).slice(0, 300)}`,
      });
      continue;
    }

    const data = (await response.json()) as unknown;
    return parse(data, step.provider, step.model);
  }

  // Every step either failed or was skipped
  const summary = failures
    .map((f) => `  • ${f.step.provider}/${f.step.model}: ${f.reason}`)
    .join('\n');

  throw new AggregateError(
    failures.map(
      (f) => new Error(`${f.step.provider}/${f.step.model}: ${f.reason}`),
    ),
    `All provider steps failed or were skipped:\n${summary}`,
  );
}
