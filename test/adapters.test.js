/**
 * Adapter unit tests — verify request building and response parsing for each provider.
 * All assertions run against the compiled output in dist/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnthropicRequest,
  parseAnthropicResponse,
  buildOpenAIRequest,
  parseOpenAIResponse,
  buildGoogleRequest,
  parseGoogleResponse,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIMPLE = {
  messages: [{ role: 'user', content: 'Hello' }],
};

const FULL = {
  system: 'You are helpful',
  messages: [
    { role: 'user', content: 'Ping' },
    { role: 'assistant', content: 'Pong' },
    { role: 'user', content: 'Again?' },
  ],
  maxTokens: 256,
  temperature: 0.7,
};

const WITH_SCHEMA = {
  messages: [{ role: 'user', content: 'List 3 colors' }],
  jsonSchema: {
    type: 'object',
    properties: { colors: { type: 'array', items: { type: 'string' } } },
    required: ['colors'],
  },
};

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

describe('Anthropic adapter — buildAnthropicRequest', () => {
  it('builds correct URL', () => {
    const { url } = buildAnthropicRequest(SIMPLE, 'claude-3-haiku', 'key', 'https://api.anthropic.com');
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
  });

  it('uses custom base URL (e.g. CF gateway)', () => {
    const { url } = buildAnthropicRequest(
      SIMPLE,
      'claude-3-haiku',
      'key',
      'https://gateway.ai.cloudflare.com/v1/a/b/anthropic',
    );
    assert.ok(url.includes('cloudflare.com'), url);
    assert.ok(url.endsWith('/v1/messages'), url);
  });

  it('sets x-api-key and anthropic-version headers', () => {
    const { init } = buildAnthropicRequest(SIMPLE, 'model', 'my-api-key', 'https://api.anthropic.com');
    assert.equal(init.headers['x-api-key'], 'my-api-key');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers['Content-Type'], 'application/json');
  });

  it('includes model in body', () => {
    const { init } = buildAnthropicRequest(SIMPLE, 'claude-opus-4', 'k', 'https://api.anthropic.com');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-opus-4');
  });

  it('includes system, maxTokens, temperature from FULL request', () => {
    const { init } = buildAnthropicRequest(FULL, 'claude-haiku', 'k', 'https://api.anthropic.com');
    const body = JSON.parse(init.body);
    assert.equal(body.system, 'You are helpful');
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.7);
  });

  it('defaults max_tokens to 4096 when not specified', () => {
    const { init } = buildAnthropicRequest(SIMPLE, 'claude-haiku', 'k', 'https://api.anthropic.com');
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 4096);
  });

  it('adds tool_choice + tools for jsonSchema', () => {
    const { init } = buildAnthropicRequest(WITH_SCHEMA, 'claude-haiku', 'k', 'https://api.anthropic.com');
    const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body.tools), 'should have tools array');
    assert.equal(body.tools[0].name, 'json_output');
    assert.deepEqual(body.tools[0].input_schema, WITH_SCHEMA.jsonSchema);
    assert.equal(body.tool_choice.type, 'tool');
    assert.equal(body.tool_choice.name, 'json_output');
  });

  it('preserves message order', () => {
    const { init } = buildAnthropicRequest(FULL, 'claude-haiku', 'k', 'https://api.anthropic.com');
    const body = JSON.parse(init.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[2].role, 'user');
  });
});

describe('Anthropic adapter — parseAnthropicResponse', () => {
  it('extracts text from content[0].text block', () => {
    const raw = { content: [{ type: 'text', text: 'Hi there!' }] };
    const result = parseAnthropicResponse(raw, 'anthropic', 'claude-haiku');
    assert.equal(result.text, 'Hi there!');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-haiku');
    assert.equal(result.raw, raw);
  });

  it('stringifies tool_use.input for jsonSchema responses', () => {
    const input = { colors: ['red', 'green', 'blue'] };
    const raw = { content: [{ type: 'tool_use', name: 'json_output', input }] };
    const result = parseAnthropicResponse(raw, 'anthropic', 'claude-haiku');
    assert.equal(result.text, JSON.stringify(input));
  });

  it('prefers first text block over tool_use when both present', () => {
    const raw = {
      content: [
        { type: 'text', text: 'Thinking…' },
        { type: 'tool_use', name: 'json_output', input: { x: 1 } },
      ],
    };
    const result = parseAnthropicResponse(raw, 'anthropic', 'claude-haiku');
    assert.equal(result.text, 'Thinking…');
  });
});

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

describe('OpenAI adapter — buildOpenAIRequest', () => {
  const BASE = 'https://api.openai.com/v1';

  it('builds correct URL', () => {
    const { url } = buildOpenAIRequest(SIMPLE, 'gpt-4o', 'key', BASE);
    assert.equal(url, `${BASE}/chat/completions`);
  });

  it('sets Authorization: Bearer header', () => {
    const { init } = buildOpenAIRequest(SIMPLE, 'gpt-4o', 'sk-test', BASE);
    assert.equal(init.headers['Authorization'], 'Bearer sk-test');
  });

  it('prepends system message when system is set', () => {
    const { init } = buildOpenAIRequest(FULL, 'gpt-4o', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'You are helpful');
    // user/assistant/user follow
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[2].role, 'assistant');
    assert.equal(body.messages[3].role, 'user');
    assert.equal(body.messages.length, 4);
  });

  it('omits system message from messages array when not set', () => {
    const { init } = buildOpenAIRequest(SIMPLE, 'gpt-4o', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages.length, 1);
  });

  it('sets response_format for jsonSchema, normalized to OpenAI strict mode', () => {
    const { init } = buildOpenAIRequest(WITH_SCHEMA, 'gpt-4o', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.type, 'json_schema');
    // strict mode requires additionalProperties: false on every object node,
    // auto-applied even though WITH_SCHEMA.jsonSchema didn't specify it.
    assert.deepEqual(body.response_format.json_schema.schema, {
      type: 'object',
      properties: { colors: { type: 'array', items: { type: 'string' } } },
      required: ['colors'],
      additionalProperties: false,
    });
    assert.equal(body.response_format.json_schema.strict, true);
  });

  it('forces required to include every property key (strict mode)', () => {
    const req = {
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          count: { type: 'integer' },
        },
        // deliberately incomplete — adapter should still force both keys required
        required: ['count'],
      },
    };
    const { init } = buildOpenAIRequest(req, 'gpt-4o', 'k', BASE);
    const body = JSON.parse(init.body);
    const schema = body.response_format.json_schema.schema;
    assert.deepEqual(schema.required, ['name', 'count']);
    assert.equal(schema.additionalProperties, false);
  });

  it('preserves an explicit additionalProperties value instead of overwriting it', () => {
    const req = {
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      },
    };
    const { init } = buildOpenAIRequest(req, 'gpt-4o', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, true);
  });

  it('includes max_tokens, temperature', () => {
    const { init } = buildOpenAIRequest(FULL, 'gpt-4o', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.7);
  });
});

describe('OpenAI adapter — parseOpenAIResponse', () => {
  it('extracts choices[0].message.content', () => {
    const raw = { choices: [{ message: { content: 'World' } }] };
    const result = parseOpenAIResponse(raw, 'openai', 'gpt-4o');
    assert.equal(result.text, 'World');
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// zai-glm adapter (OpenAI-compatible, just a different base URL)
// ---------------------------------------------------------------------------

describe('zai-glm adapter', () => {
  const ZAI_BASE = 'https://open.bigmodel.cn/api/paas/v4';

  it('uses z.ai base URL in the built request', () => {
    const { url } = buildOpenAIRequest(SIMPLE, 'glm-4-plus', 'zai-key', ZAI_BASE);
    assert.equal(url, `${ZAI_BASE}/chat/completions`);
    assert.ok(url.includes('bigmodel.cn'), url);
  });

  it('sets Bearer auth for zai-glm', () => {
    const { init } = buildOpenAIRequest(SIMPLE, 'glm-4-plus', 'my-zai-key', ZAI_BASE);
    assert.equal(init.headers['Authorization'], 'Bearer my-zai-key');
  });

  it('parses zai-glm response identically to openai', () => {
    const raw = { choices: [{ message: { content: 'GLM response' } }] };
    const result = parseOpenAIResponse(raw, 'zai-glm', 'glm-4-plus');
    assert.equal(result.text, 'GLM response');
    assert.equal(result.provider, 'zai-glm');
  });
});

// ---------------------------------------------------------------------------
// Google adapter
// ---------------------------------------------------------------------------

describe('Google adapter — buildGoogleRequest', () => {
  const BASE = 'https://generativelanguage.googleapis.com';

  it('builds URL with model path and ?key= query param', () => {
    const { url } = buildGoogleRequest(SIMPLE, 'gemini-2.5-flash', 'gkey', BASE);
    assert.ok(url.includes('/v1beta/models/gemini-2.5-flash:generateContent'), `URL: ${url}`);
    assert.ok(url.includes('?key=gkey'), `URL: ${url}`);
    assert.ok(!url.includes('Authorization'), 'key should be in query param, not header');
  });

  it('uses CF gateway base URL when provided', () => {
    const gwBase = 'https://gateway.ai.cloudflare.com/v1/a/b/google-ai-studio';
    const { url } = buildGoogleRequest(SIMPLE, 'gemini-2.5-flash', 'gkey', gwBase);
    assert.ok(url.startsWith(gwBase), `URL: ${url}`);
    assert.ok(url.includes(':generateContent'), `URL: ${url}`);
  });

  it('maps assistant role to "model"', () => {
    const req = {
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Bye' },
      ],
    };
    const { init } = buildGoogleRequest(req, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[1].role, 'model');
    assert.equal(body.contents[2].role, 'user');
  });

  it('includes systemInstruction when system is set', () => {
    const { init } = buildGoogleRequest(FULL, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.ok(body.systemInstruction, 'should have systemInstruction');
    assert.equal(body.systemInstruction.parts[0].text, 'You are helpful');
  });

  it('omits systemInstruction when system is absent', () => {
    const { init } = buildGoogleRequest(SIMPLE, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.ok(!body.systemInstruction, 'should not have systemInstruction');
  });

  it('sets generationConfig.maxOutputTokens and temperature', () => {
    const { init } = buildGoogleRequest(FULL, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.maxOutputTokens, 256);
    assert.equal(body.generationConfig.temperature, 0.7);
  });

  it('sets responseSchema in generationConfig for jsonSchema, translated to Gemini dialect', () => {
    const { init } = buildGoogleRequest(WITH_SCHEMA, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    // Gemini's Schema dialect uses UPPERCASE type enum values, not the
    // lowercase JSON Schema convention used in the canonical request input.
    assert.deepEqual(body.generationConfig.responseSchema, {
      type: 'OBJECT',
      properties: { colors: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['colors'],
    });
  });

  it('converts a type: [T, "null"] union to UPPERCASE type + nullable: true', () => {
    const req = {
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'], enum: ['a', 'b'] },
          count: { type: ['integer', 'null'] },
        },
        required: ['name', 'count'],
      },
    };
    const { init } = buildGoogleRequest(req, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    const schema = body.generationConfig.responseSchema;
    assert.deepEqual(schema.properties.name, { type: 'STRING', nullable: true, enum: ['a', 'b'] });
    assert.deepEqual(schema.properties.count, { type: 'INTEGER', nullable: true });
  });

  it('drops additionalProperties (Gemini rejects unknown schema keys)', () => {
    const req = {
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      },
    };
    const { init } = buildGoogleRequest(req, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.responseSchema.additionalProperties, undefined);
  });

  it('omits generationConfig when nothing is set', () => {
    const { init } = buildGoogleRequest(SIMPLE, 'gemini-2.5-flash', 'k', BASE);
    const body = JSON.parse(init.body);
    assert.ok(!body.generationConfig, 'should not have empty generationConfig');
  });
});

describe('Google adapter — parseGoogleResponse', () => {
  it('concatenates all text parts', () => {
    const raw = {
      candidates: [
        { content: { parts: [{ text: 'Hello' }, { text: ' world' }] } },
      ],
    };
    const result = parseGoogleResponse(raw, 'google', 'gemini-2.5-flash');
    assert.equal(result.text, 'Hello world');
    assert.equal(result.provider, 'google');
    assert.equal(result.model, 'gemini-2.5-flash');
  });

  it('handles single text part', () => {
    const raw = {
      candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] } }],
    };
    const result = parseGoogleResponse(raw, 'google', 'gemini-2.5-flash');
    assert.equal(result.text, 'Gemini says hi');
  });
});

// ---------------------------------------------------------------------------
// Multimodal content normalization
// ---------------------------------------------------------------------------

describe('Multimodal content handling', () => {
  it('openai adapter passes through image_url blocks', () => {
    const req = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
          ],
        },
      ],
    };
    const { init } = buildOpenAIRequest(req, 'gpt-4o', 'k', 'https://api.openai.com/v1');
    const body = JSON.parse(init.body);
    const parts = body.messages[0].content;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url.url, 'https://example.com/img.png');
  });

  it('anthropic adapter passes through image blocks', () => {
    const req = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        },
      ],
    };
    const { init } = buildAnthropicRequest(req, 'claude-haiku', 'k', 'https://api.anthropic.com');
    const body = JSON.parse(init.body);
    const parts = body.messages[0].content;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image');
    assert.equal(parts[1].source.type, 'base64');
    assert.equal(parts[1].source.media_type, 'image/png');
  });

  it('google adapter converts base64 image blocks to inlineData parts', () => {
    const req = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this nameplate' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'zzz789' } },
          ],
        },
      ],
    };
    const { init } = buildGoogleRequest(req, 'gemini-2.5-flash', 'k', 'https://generativelanguage.googleapis.com');
    const body = JSON.parse(init.body);
    const parts = body.contents[0].parts;
    assert.equal(parts[0].text, 'Read this nameplate');
    assert.equal(parts[1].inlineData.mimeType, 'image/jpeg');
    assert.equal(parts[1].inlineData.data, 'zzz789');
  });

  it('google adapter decodes data: image_url blocks to inlineData parts', () => {
    const req = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
          ],
        },
      ],
    };
    const { init } = buildGoogleRequest(req, 'gemini-2.5-flash', 'k', 'https://generativelanguage.googleapis.com');
    const body = JSON.parse(init.body);
    const part = body.contents[0].parts[0];
    assert.equal(part.inlineData.mimeType, 'image/png');
    assert.equal(part.inlineData.data, 'YWJj');
  });

  it('google adapter passes non-data image_url blocks through as fileData', () => {
    const req = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }],
        },
      ],
    };
    const { init } = buildGoogleRequest(req, 'gemini-2.5-flash', 'k', 'https://generativelanguage.googleapis.com');
    const body = JSON.parse(init.body);
    const part = body.contents[0].parts[0];
    assert.equal(part.fileData.fileUri, 'https://example.com/img.png');
  });
});
