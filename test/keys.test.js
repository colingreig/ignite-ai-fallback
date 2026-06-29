/**
 * Key resolution tests — verifies env var lookup, override precedence, and skip behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runWithFallback, readEnv } from '../dist/index.js';

const OPENAI_OK = { choices: [{ message: { content: 'ok' } }] };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// ---------------------------------------------------------------------------
// readEnv
// ---------------------------------------------------------------------------

describe('readEnv', () => {
  it('reads from process.env', () => {
    process.env['__TEST_KEY_123__'] = 'hello';
    try {
      assert.equal(readEnv('__TEST_KEY_123__'), 'hello');
    } finally {
      delete process.env['__TEST_KEY_123__'];
    }
  });

  it('returns undefined for missing key', () => {
    assert.equal(readEnv('__DEFINITELY_NOT_SET__'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Key resolution precedence
// ---------------------------------------------------------------------------

describe('Key resolution', () => {
  let savedKey;

  beforeEach(() => {
    savedKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env['OPENAI_API_KEY'] = savedKey;
    else delete process.env['OPENAI_API_KEY'];
  });

  it('uses opts.keys override when env var is absent', async () => {
    const fetchImpl = async () => jsonResponse(OPENAI_OK);

    const result = await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { keys: { openai: 'override-key' }, fetchImpl },
    );
    assert.equal(result.provider, 'openai');
  });

  it('uses OPENAI_API_KEY env var when no opts.keys provided', async () => {
    process.env['OPENAI_API_KEY'] = 'env-key';
    let capturedInit;
    const fetchImpl = async (_url, init) => {
      capturedInit = init;
      return jsonResponse(OPENAI_OK);
    };

    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl },
    );

    assert.ok(capturedInit.headers['Authorization'].includes('env-key'), 'env key should be used');
  });

  it('opts.keys takes precedence over env var', async () => {
    process.env['OPENAI_API_KEY'] = 'env-key';
    let capturedInit;
    const fetchImpl = async (_url, init) => {
      capturedInit = init;
      return jsonResponse(OPENAI_OK);
    };

    await runWithFallback(
      [{ provider: 'openai', model: 'gpt-4o' }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { keys: { openai: 'override-key' }, fetchImpl },
    );

    assert.ok(
      capturedInit.headers['Authorization'].includes('override-key'),
      'override key should win over env var',
    );
  });

  it('skips step when key is absent from both opts and env', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return jsonResponse(OPENAI_OK);
    };

    // anthropic key is absent; openai key is provided
    await runWithFallback(
      [
        { provider: 'anthropic', model: 'claude-haiku' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
      { messages: [{ role: 'user', content: 'hi' }] },
      { keys: { openai: 'ok' }, fetchImpl },
    );

    // Only openai call should have been made
    assert.equal(callCount, 1, 'should make 1 HTTP call (anthropic was skipped)');
  });

  it('includes skipped steps in AggregateError.errors', async () => {
    // No keys at all
    let caught;
    try {
      await runWithFallback(
        [
          { provider: 'anthropic', model: 'claude-haiku' },
          { provider: 'openai', model: 'gpt-4o' },
        ],
        { messages: [{ role: 'user', content: 'hi' }] },
        { keys: {} },
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AggregateError);
    assert.equal(caught.errors.length, 2);
    assert.ok(
      caught.errors[0].message.includes('anthropic'),
      `first error: ${caught.errors[0].message}`,
    );
    assert.ok(
      caught.errors[1].message.includes('openai'),
      `second error: ${caught.errors[1].message}`,
    );
  });
});
