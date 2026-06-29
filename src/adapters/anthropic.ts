import type { ChatRequest, ChatResult, Provider, MessageContent } from '../types.js';

const DEFAULT_MAX_TOKENS = 4096;

function normalizeContent(content: MessageContent): unknown {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'image') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.media_type,
          data: block.source.data,
        },
      };
    }
    // image_url → Anthropic URL source (models/claude-3-* support this)
    return {
      type: 'image',
      source: { type: 'url', url: block.image_url.url },
    };
  });
}

/**
 * Translates a ChatRequest into an Anthropic Messages API HTTP call.
 *
 * Endpoint: POST {base}/v1/messages
 * Auth:     x-api-key header + anthropic-version header
 *
 * Gateway slug (when CF AI Gateway is configured): "anthropic"
 * → {gatewayBase}/anthropic/v1/messages
 */
export function buildAnthropicRequest(
  request: ChatRequest,
  model: string,
  apiKey: string,
  baseUrl: string,
): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: normalizeContent(m.content),
    })),
  };

  if (request.system) body['system'] = request.system;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;

  if (request.jsonSchema) {
    // Force structured output via tool-use
    body['tools'] = [
      {
        name: 'json_output',
        description: 'Return structured JSON',
        input_schema: request.jsonSchema,
      },
    ];
    body['tool_choice'] = { type: 'tool', name: 'json_output' };
  }

  return {
    url: `${baseUrl}/v1/messages`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      } as Record<string, string>,
      body: JSON.stringify(body),
    },
  };
}

/** Parses an Anthropic Messages API response into a normalized ChatResult. */
export function parseAnthropicResponse(
  data: unknown,
  provider: Provider,
  model: string,
): ChatResult {
  const d = data as {
    content: Array<{ type: string; text?: string; input?: unknown }>;
  };

  let text = '';
  for (const block of d.content) {
    if (block.type === 'text' && block.text != null) {
      text = block.text;
      break;
    }
    if (block.type === 'tool_use' && block.input != null) {
      // jsonSchema mode — tool input IS the structured response
      text = JSON.stringify(block.input);
      break;
    }
  }

  return { text, provider, model, raw: data };
}
