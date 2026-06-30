/**
 * @module types
 * All public types for @ignitemarketing/ai-fallback.
 */

/** Supported LLM providers. */
export type Provider = 'anthropic' | 'openai' | 'google' | 'zai-glm';

/** One step in a fallback chain — a provider + model pair. */
export interface ProviderStep {
  provider: Provider;
  model: string;
}

// ---------------------------------------------------------------------------
// Message content
// ---------------------------------------------------------------------------

/** A text content block. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** An image referenced by URL (OpenAI / zai-glm style). */
export interface ImageUrlBlock {
  type: 'image_url';
  image_url: { url: string };
}

/** A base64-encoded inline image (Anthropic style). */
export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ContentBlock = TextBlock | ImageUrlBlock | ImageBlock;

/** Message content — either a plain string or a multimodal array of blocks. */
export type MessageContent = string | ContentBlock[];

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: MessageContent;
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/** Normalized, provider-agnostic chat request. */
export interface ChatRequest {
  /** Optional system prompt. */
  system?: string;
  messages: ChatMessage[];
  /** Max tokens to generate (provider default used when absent). */
  maxTokens?: number;
  temperature?: number;
  /**
   * JSON Schema for structured output.
   * Adapters translate this to the provider's native mechanism
   * (Anthropic: tool calling; OpenAI: response_format json_schema; Google: responseSchema).
   */
  jsonSchema?: object;
}

/** Normalized, provider-agnostic chat result. */
export interface ChatResult {
  /** Extracted text (or JSON string when jsonSchema was set). */
  text: string;
  provider: Provider;
  model: string;
  /** Raw JSON response body from the provider — useful for inspecting token counts etc. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FallbackOptions {
  /**
   * Cloudflare AI Gateway base URL, e.g.:
   *   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}
   *
   * When set, supported providers route through the gateway:
   *   anthropic     → {gatewayBase}/anthropic/v1/messages
   *   openai        → {gatewayBase}/openai/chat/completions
   *   google        → {gatewayBase}/google-ai-studio/v1beta/models/{model}:generateContent
   *
   * zai-glm ALWAYS bypasses the gateway — Cloudflare has no native z.ai provider.
   */
  gatewayBase?: string;

  /** AbortSignal for cancelling in-flight requests. */
  signal?: AbortSignal;

  /**
   * API key overrides per provider.
   * Falls back to environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY,
   * GEMINI_API_KEY, ZAI_API_KEY) when a key is absent from this map.
   * A step whose key resolves to undefined is silently skipped (non-fatal).
   */
  keys?: Partial<Record<Provider, string>>;

  /**
   * Override the fetch implementation.
   * Defaults to globalThis.fetch (available in Node 18+, Workers, Deno).
   * Useful for testing without real network calls.
   */
  fetchImpl?: typeof fetch;

  /**
   * Extra HTTP headers merged into every provider request, after the
   * adapter's own headers (so adapter auth headers win on collision).
   * Use for Cloudflare AI Gateway observability tags, e.g.:
   *   { 'cf-aig-metadata': JSON.stringify({ project: 'luxuryexoticrental' }) }
   * Harmless to direct providers — unknown headers are ignored.
   */
  extraHeaders?: Record<string, string>;
}
