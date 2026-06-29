import type { ChatRequest, ChatResult, Provider, MessageContent } from '../types.js';

const DEFAULT_MAX_TOKENS = 4096;

function normalizeContent(content: MessageContent): unknown {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'image_url') {
      return { type: 'image_url', image_url: block.image_url };
    }
    // Anthropic-style base64 image → OpenAI data URL
    return {
      type: 'image_url',
      image_url: {
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      },
    };
  });
}

/**
 * Translates a ChatRequest into an OpenAI chat/completions HTTP call.
 *
 * Endpoint: POST {base}/chat/completions
 * Auth:     Authorization: Bearer {apiKey}
 *
 * This function is ALSO used by the 'zai-glm' provider, which is OpenAI-compatible.
 * The only difference is the base URL (https://open.bigmodel.cn/api/paas/v4 by default).
 *
 * Gateway slug (when CF AI Gateway is configured): "openai"
 * → {gatewayBase}/openai/chat/completions
 *
 * zai-glm NEVER routes through the gateway — CF has no native z.ai provider.
 */
export function buildOpenAIRequest(
  request: ChatRequest,
  model: string,
  apiKey: string,
  baseUrl: string,
): { url: string; init: RequestInit } {
  const messages: Array<{ role: string; content: unknown }> = [];

  // System prompt becomes a system-role message (OpenAI convention)
  if (request.system) {
    messages.push({ role: 'system', content: request.system });
  }
  for (const m of request.messages) {
    messages.push({ role: m.role, content: normalizeContent(m.content) });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  if (request.temperature !== undefined) body['temperature'] = request.temperature;

  if (request.jsonSchema) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: request.jsonSchema,
        strict: true,
      },
    };
  }

  return {
    url: `${baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      } as Record<string, string>,
      body: JSON.stringify(body),
    },
  };
}

/** Parses an OpenAI chat/completions response (or any OpenAI-compatible response). */
export function parseOpenAIResponse(
  data: unknown,
  provider: Provider,
  model: string,
): ChatResult {
  const d = data as {
    choices: Array<{ message: { content: string } }>;
  };
  return {
    text: d.choices[0].message.content,
    provider,
    model,
    raw: data,
  };
}
