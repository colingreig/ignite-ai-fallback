import type { ChatRequest, ChatResult, Provider, MessageContent } from '../types.js';

type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType?: string } };

// data:<mime>;base64,<data> — used for ImageUrlBlock when the URL is a data URI.
const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Converts normalized ContentBlocks to Gemini `parts`.
 *   - text             → { text }
 *   - image (base64)   → { inlineData: { mimeType, data } }
 *   - image_url (data:)→ { inlineData } (decoded from the data URI)
 *   - image_url (http) → { fileData: { fileUri } } (best-effort; Gemini natively
 *     expects Files API URIs here, so an arbitrary public URL may be rejected by
 *     the API — caller should prefer base64 ImageBlocks for reliable multimodal
 *     input to Google.)
 */
function toParts(content: MessageContent): GooglePart[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((b): GooglePart => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'image') {
      return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    }
    // image_url
    const dataMatch = b.image_url.url.match(DATA_URL_RE);
    if (dataMatch) {
      return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
    }
    return { fileData: { fileUri: b.image_url.url } };
  });
}

/**
 * Recursively translates a standard JSON Schema (lowercase types; nullable
 * fields expressed as `type: [T, "null"]`) into Gemini's `Schema` dialect
 * (single UPPERCASE `type` string + a separate `nullable: true` boolean).
 * Gemini's REST endpoint rejects unrecognized fields outright (e.g.
 * `additionalProperties`), so only the keys Gemini's Schema message actually
 * supports are carried forward.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  let type = s['type'];
  let nullable = s['nullable'] === true;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (nonNull.length !== type.length) nullable = true;
    type = nonNull[0];
  }
  if (typeof type === 'string') out['type'] = type.toUpperCase();
  if (nullable) out['nullable'] = true;
  if (s['description'] !== undefined) out['description'] = s['description'];
  if (s['format'] !== undefined) out['format'] = s['format'];
  if (s['enum'] !== undefined) out['enum'] = s['enum'];
  if (s['items'] !== undefined) out['items'] = toGeminiSchema(s['items']);
  if (s['properties'] !== undefined && typeof s['properties'] === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s['properties'] as Record<string, unknown>)) {
      props[k] = toGeminiSchema(v);
    }
    out['properties'] = props;
  }
  if (s['required'] !== undefined) out['required'] = s['required'];

  return out;
}

/**
 * Translates a ChatRequest into a Google Gemini generateContent HTTP call.
 *
 * Endpoint: POST {base}/v1beta/models/{model}:generateContent?key={apiKey}
 * Auth:     API key in query param (not a Bearer header)
 *
 * Role mapping: ChatMessage.role 'assistant' → Gemini role 'model'.
 *
 * Gateway slug (when CF AI Gateway is configured): "google-ai-studio"
 * → {gatewayBase}/google-ai-studio/v1beta/models/{model}:generateContent
 *   (the ?key= is still appended for non-gateway direct calls)
 */
export function buildGoogleRequest(
  request: ChatRequest,
  model: string,
  apiKey: string,
  baseUrl: string,
): { url: string; init: RequestInit } {
  const contents = request.messages.map((m) => ({
    // Gemini uses 'model' where OpenAI/Anthropic use 'assistant'
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toParts(m.content),
  }));

  const body: Record<string, unknown> = { contents };

  if (request.system) {
    body['systemInstruction'] = { parts: [{ text: request.system }] };
  }

  const genConfig: Record<string, unknown> = {};
  if (request.maxTokens !== undefined) genConfig['maxOutputTokens'] = request.maxTokens;
  if (request.temperature !== undefined) genConfig['temperature'] = request.temperature;
  if (request.jsonSchema) {
    genConfig['responseMimeType'] = 'application/json';
    genConfig['responseSchema'] = toGeminiSchema(request.jsonSchema);
  }
  if (Object.keys(genConfig).length > 0) body['generationConfig'] = genConfig;

  // Gemini takes the API key as ?key= query param, not an Authorization header
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  return {
    url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' } as Record<string, string>,
      body: JSON.stringify(body),
    },
  };
}

/** Parses a Gemini generateContent response into a normalized ChatResult. */
export function parseGoogleResponse(
  data: unknown,
  provider: Provider,
  model: string,
): ChatResult {
  const d = data as {
    candidates: Array<{
      content: { parts: Array<{ text?: string }> };
    }>;
  };
  const parts = d.candidates[0].content.parts;
  const text = parts.map((p) => p.text ?? '').join('');
  return { text, provider, model, raw: data };
}
