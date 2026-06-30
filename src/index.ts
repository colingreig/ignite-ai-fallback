/**
 * @ignitemarketing/ai-fallback
 *
 * Fetch-based LLM provider fallback with zero runtime dependencies.
 * Works in Node.js 18+, Cloudflare Workers, Deno, and plain .mjs scripts.
 *
 * @example
 * ```ts
 * import { runWithFallback } from '@ignitemarketing/ai-fallback';
 *
 * const result = await runWithFallback(
 *   [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
 *     { provider: 'openai',    model: 'gpt-4o' },
 *     { provider: 'zai-glm',  model: 'glm-4-plus' },
 *   ],
 *   { messages: [{ role: 'user', content: 'Hello!' }] },
 * );
 * console.log(result.text, 'from', result.provider);
 * ```
 */

// Core function
export { runWithFallback } from './fallback.js';

// Types
export type {
  Provider,
  ProviderStep,
  ContentBlock,
  TextBlock,
  ImageUrlBlock,
  ImageBlock,
  MessageContent,
  ChatMessage,
  ChatRequest,
  ChatResult,
  FallbackOptions,
} from './types.js';

// Adapter functions — exported for callers that want to use an adapter directly
export { buildAnthropicRequest, parseAnthropicResponse } from './adapters/anthropic.js';
export { buildOpenAIRequest, parseOpenAIResponse } from './adapters/openai.js';
export { buildGoogleRequest, parseGoogleResponse } from './adapters/google.js';

// Env helper — exported so callers can use it for their own key resolution
export { readEnv } from './env.js';
