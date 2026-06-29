import type { ChatRequest, ChatResult, Provider, MessageContent } from '../types.js';

function toParts(content: MessageContent): Array<{ text: string }> {
  if (typeof content === 'string') return [{ text: content }];
  // Google's generateContent API supports inline images too, but for simplicity
  // we pass only text parts here; extend if multimodal Google support is needed.
  return content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => ({ text: b.text }));
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
    genConfig['responseSchema'] = request.jsonSchema;
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
