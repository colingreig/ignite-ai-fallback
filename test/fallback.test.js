/**
 * Tests for runWithFallback — chain advancement, key skipping, error handling.
 * Uses node:test + node:assert with mocked fetch (opts.fetchImpl) — no real network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithFallback } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANTHROPIC_OK = {
  content: [{ type: 'text', text: 'Hello from Anthropic' }],
};
const OPENAI_OK = {
  choices: [{ message: { content: 'Hello from OpenAI' } }],
};
const GOOGLE_OK = {
  candidates: [{ content: { parts: [{ text: 'Hello from Google' }] } }],
};
const ZAI_OK = {
  choices: [{ message: { content: 'Hello from zai-glm' } }],
};

function makeRequest(extra = {}) {
  return { messages: [{ role: 'user', content: 'Say hello' }], ...extra };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe('runWithFallback — first-step success', () => {
  it('returns result from anthropic when step 1 succeeds', async () => {
    const fetchImpl = async (url) => {
      assert.ok(url.includes('api.anthropic.com'), `unexpected URL: ${url}`);
      return jsonResponse(ANTHROPIC_OK);
    };

    const result = await runWithFallback(
      [{ provider: 'anthropic', model: 'claude-3-haiku-20240307' }],
      makeRequest(),
      { keys: { anthropic: 'test-key' }, fetchImpl },
    );

    assert.equal(result.text, 'Hello from Anthropic');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-3-haiku-20240307');
  });

  it('returns result from openai when called directly', async () => {
    const fetchImpl = async () => jsonResponse(OPENAI_OK);

    const result = await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      makeRequest(),
      { keys: { openai: 'test-key' }, fetchImpl },
    );

    assert.equal(result.text, 'Hello from OpenAI');
    assert.equal(result.provider, 'openai');
  });

  it('returns result from google', async () => {
    const fetchImpl = async () => jsonResponse(GOOGLE_OK);

    const result = await runWithFallback(
      [{ provider: 'google', model: 'gemini-2.5-flash' }],
      makeRequest(),
      { keys: { google: 'test-key' }, fetchImpl },
    );

    assert.equal(result.text, 'Hello from Google');
    assert.equal(result.provider, 'google');
  });

  it('returns result from zai-glm', async () => {
    const fetchImpl = async (url) => {
      assert.ok(url.includes('api.z.ai'), `expected z.ai URL, got: ${url}`);
      return jsonResponse(ZAI_OK);
    };

    const result = await runWithFallback(
      [{ provider: 'zai-glm', model: 'glm-4-plus' }],
      makeRequest(),
      { keys: { 'zai-glm': 'test-key' }, fetchImpl },
    );

    assert.equal(result.text, 'Hello from zai-glm');
    assert.equal(result.provider, 'zai-glm');
  });
});

// ---------------------------------------------------------------------------
// Chain advancement on 429 / 5xx
// ---------------------------------------------------------------------------

describe('runWithFallback — chain advancement', () => {
  it('advances from step 1 to step 2 on HTTP 429', async () => {
    let callCount = 0;
    const fetchImpl = async (url) => {
      callCount++;
      if (callCount === 1) {
        assert.ok(url.includes('api.anthropic.com'), `step 1 should hit anthropic, got ${url}`);
        return jsonResponse({ error: 'rate_limit_error' }, 429);
      }
      assert.ok(url.includes('api.openai.com'), `step 2 should hit openai, got ${url}`);
      return jsonResponse(OPENAI_OK);
    };

    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
      makeRequest(),
      { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
    );

    assert.equal(result.provider, 'openai');
    assert.equal(result.text, 'Hello from OpenAI');
    assert.equal(callCount, 2, 'should have made exactly 2 HTTP calls');
  });

  it('advances from step 1 to step 2 on HTTP 500', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount === 1) return new Response('Internal Server Error', { status: 500 });
      return jsonResponse(OPENAI_OK);
    };

    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
      makeRequest(),
      { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
    );

    assert.equal(result.provider, 'openai');
  });

  it('advances on any 5xx (including 529 overloaded)', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount === 1) return jsonResponse({ error: 'overloaded' }, 529);
      return jsonResponse(GOOGLE_OK);
    };

    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'google', model: 'gemini-2.5-flash' },
      ],
      makeRequest(),
      { keys: { anthropic: 'k1', google: 'k2' }, fetchImpl },
    );

    assert.equal(result.provider, 'google');
    assert.equal(callCount, 2);
  });

  it('advances on network error (fetch throws)', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount === 1) throw new TypeError('fetch failed: ECONNREFUSED');
      return jsonResponse(OPENAI_OK);
    };

    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
      makeRequest(),
      { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
    );

    assert.equal(result.provider, 'openai');
  });

  it('walks all 3 steps when first two fail', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount < 3) return jsonResponse({ error: 'overloaded' }, 503);
      return jsonResponse(ZAI_OK);
    };

    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'zai-glm', model: 'glm-4-plus' },
      ],
      makeRequest(),
      { keys: { anthropic: 'k1', openai: 'k2', 'zai-glm': 'k3' }, fetchImpl },
    );

    assert.equal(result.provider, 'zai-glm');
    assert.equal(callCount, 3);
  });
});

// ---------------------------------------------------------------------------
// AggregateError when all steps fail
// ---------------------------------------------------------------------------

describe('runWithFallback — total failure', () => {
  it('throws AggregateError when all steps return 429', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'rate_limit' }, 429);

    await assert.rejects(
      () =>
        runWithFallback(
          [
            { provider: 'anthropic', model: 'claude-haiku' },
            { provider: 'openai', model: 'gpt-4o' },
          ],
          makeRequest(),
          { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
        ),
      (err) => {
        assert.ok(err instanceof AggregateError, `Expected AggregateError, got ${err?.constructor?.name}`);
        assert.ok(err.message.includes('All provider steps'), err.message);
        assert.equal(err.errors.length, 2, 'Should have 2 individual errors');
        return true;
      },
    );
  });

  it('throws AggregateError listing both step reasons', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'overloaded' }, 503);

    let caught;
    try {
      await runWithFallback(
        [
          { provider: 'anthropic', model: 'claude-haiku' },
          { provider: 'openai', model: 'gpt-4o' },
        ],
        makeRequest(),
        { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AggregateError);
    assert.ok(caught.message.includes('anthropic'), 'should mention anthropic in message');
    assert.ok(caught.message.includes('openai'), 'should mention openai in message');
  });

  it('advances past a non-retryable 4xx (revoked key on primary routes to next)', async () => {
    let callCount = 0;
    const fetchImpl = async (url) => {
      callCount++;
      // Primary (anthropic) returns 401 — a revoked/invalid key. A resilience
      // chain must route around it, not kill the request.
      if (url.includes('anthropic') || url.includes('api.anthropic')) {
        return jsonResponse({ error: 'invalid_api_key' }, 401);
      }
      return jsonResponse(
        { choices: [{ message: { content: 'served by openai' } }] },
        200,
      );
    };

    const result = await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
      makeRequest(),
      { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
    );

    assert.equal(callCount, 2, 'Should advance past the 401 to the next provider');
    assert.equal(result.provider, 'openai');
    assert.equal(result.text, 'served by openai');
  });

  it('throws AggregateError when every step fails with a 4xx', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'invalid_api_key' }, 401);

    await assert.rejects(
      () =>
        runWithFallback(
          [
            { provider: 'anthropic', model: 'claude-haiku' },
            { provider: 'openai', model: 'gpt-4o' },
          ],
          makeRequest(),
          { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl },
        ),
      (err) => {
        assert.ok(err instanceof AggregateError, 'Should be AggregateError when chain exhausts');
        assert.ok(err.message.includes('401'), err.message);
        return true;
      },
    );
  });

  it('re-throws AbortError immediately without advancing', async () => {
    const controller = new AbortController();
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      controller.abort();
      const err = new DOMException('aborted', 'AbortError');
      throw err;
    };

    await assert.rejects(
      () =>
        runWithFallback(
          [
            { provider: 'anthropic', model: 'claude-haiku' },
            { provider: 'openai', model: 'gpt-4o' },
          ],
          makeRequest(),
          { keys: { anthropic: 'k1', openai: 'k2' }, fetchImpl, signal: controller.signal },
        ),
      (err) => {
        assert.equal(err.name, 'AbortError');
        return true;
      },
    );
    assert.equal(callCount, 1, 'Should abort after first call');
  });
});

// ---------------------------------------------------------------------------
// CF AI Gateway routing
// ---------------------------------------------------------------------------

describe('runWithFallback — CF AI Gateway routing', () => {
  const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/gw';

  it('routes anthropic through gateway slug', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return jsonResponse(ANTHROPIC_OK);
    };

    await runWithFallback(
      [{ provider: 'anthropic', model: 'claude-haiku' }],
      makeRequest(),
      { keys: { anthropic: 'k' }, gatewayBase: GATEWAY, fetchImpl },
    );

    assert.ok(capturedUrl.startsWith(`${GATEWAY}/anthropic`), `URL: ${capturedUrl}`);
  });

  it('routes openai through gateway slug', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return jsonResponse(OPENAI_OK);
    };

    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      makeRequest(),
      { keys: { openai: 'k' }, gatewayBase: GATEWAY, fetchImpl },
    );

    assert.ok(capturedUrl.startsWith(`${GATEWAY}/openai`), `URL: ${capturedUrl}`);
  });

  it('routes google through google-ai-studio gateway slug', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return jsonResponse(GOOGLE_OK);
    };

    await runWithFallback(
      [{ provider: 'google', model: 'gemini-2.5-flash' }],
      makeRequest(),
      { keys: { google: 'k' }, gatewayBase: GATEWAY, fetchImpl },
    );

    assert.ok(capturedUrl.startsWith(`${GATEWAY}/google-ai-studio`), `URL: ${capturedUrl}`);
  });

  it('zai-glm bypasses gateway even when gatewayBase is set', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return jsonResponse(ZAI_OK);
    };

    await runWithFallback(
      [{ provider: 'zai-glm', model: 'glm-4.6' }],
      makeRequest(),
      { keys: { 'zai-glm': 'k' }, gatewayBase: GATEWAY, fetchImpl },
    );

    assert.ok(capturedUrl.includes('api.z.ai'), `zai-glm should use direct URL, got: ${capturedUrl}`);
    assert.ok(!capturedUrl.includes('gateway.ai.cloudflare.com'), `Should bypass gateway, got: ${capturedUrl}`);
  });
});

describe('runWithFallback — extraHeaders', () => {
  it('merges extraHeaders into the request without clobbering adapter auth headers', async () => {
    let capturedHeaders;
    const fetchImpl = async (_url, init) => {
      capturedHeaders = init.headers;
      return jsonResponse(ANTHROPIC_OK);
    };

    await runWithFallback(
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
      makeRequest(),
      {
        keys: { anthropic: 'secret-key' },
        extraHeaders: { 'cf-aig-metadata': '{"project":"luxuryexoticrental"}' },
        fetchImpl,
      },
    );

    // Extra header present
    assert.equal(capturedHeaders['cf-aig-metadata'], '{"project":"luxuryexoticrental"}');
    // Adapter's own auth header preserved (not clobbered)
    assert.equal(capturedHeaders['x-api-key'], 'secret-key');
  });

  it('adapter headers win when extraHeaders collide with them', async () => {
    let capturedHeaders;
    const fetchImpl = async (_url, init) => {
      capturedHeaders = init.headers;
      return jsonResponse(ANTHROPIC_OK);
    };

    await runWithFallback(
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
      makeRequest(),
      {
        keys: { anthropic: 'secret-key' },
        // Attempt to override the auth header — adapter must win
        extraHeaders: { 'x-api-key': 'attacker-value' },
        fetchImpl,
      },
    );

    assert.equal(capturedHeaders['x-api-key'], 'secret-key');
  });
});

describe('runWithFallback — ZAI_BASE_URL override', () => {
  it('uses ZAI_BASE_URL env var for the zai-glm base when set', async () => {
    const prev = process.env.ZAI_BASE_URL;
    process.env.ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
    try {
      let capturedUrl;
      const fetchImpl = async (url) => {
        capturedUrl = url;
        return jsonResponse(ZAI_OK);
      };
      await runWithFallback(
        [{ provider: 'zai-glm', model: 'glm-4.6' }],
        makeRequest(),
        { keys: { 'zai-glm': 'k' }, fetchImpl },
      );
      assert.ok(capturedUrl.startsWith('https://api.z.ai/api/coding/paas/v4'), capturedUrl);
    } finally {
      if (prev === undefined) delete process.env.ZAI_BASE_URL;
      else process.env.ZAI_BASE_URL = prev;
    }
  });
});
