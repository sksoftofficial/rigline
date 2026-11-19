import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, ApiError } from '../src/Agent.js';
import {
    completion,
    textMessage,
    jsonResponse,
    makeAgent,
    requestUrl,
    requestHeaders,
    requestBody
} from './helpers.js';

test('defaults: OpenRouter baseUrl and Bearer authorization header', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))]);

    await agent.run('hi');

    assert.equal(requestUrl(fetchMock, 0), 'https://openrouter.ai/api/v1/chat/completions');
    const headers = requestHeaders(fetchMock, 0);
    assert.equal(headers.Authorization, 'Bearer sk-test-key');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(fetchMock.mock.calls[0].arguments[1].method, 'POST');
});

test('custom baseUrl (any OpenAI-compatible host) with trailing slash normalized', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))], {
        transport: { baseUrl: 'https://llm.internal:8080/v1/' }
    });

    await agent.run('hi');

    assert.equal(requestUrl(fetchMock, 0), 'https://llm.internal:8080/v1/chat/completions');
});

test('extra transport headers (e.g. OpenRouter attribution) are sent', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))], {
        transport: { headers: { 'HTTP-Referer': 'https://app.example', 'X-Title': 'My App' } }
    });

    await agent.run('hi');

    const headers = requestHeaders(fetchMock, 0);
    assert.equal(headers['HTTP-Referer'], 'https://app.example');
    assert.equal(headers['X-Title'], 'My App');
    assert.equal(headers.Authorization, 'Bearer sk-test-key');
});

test('tools are omitted from the request body when none are registered', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))]);

    await agent.run('hi');

    assert.equal(requestBody(fetchMock, 0).tools, undefined);
});

test('non-retryable 4xx fails immediately as ApiError with body attached', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [jsonResponse({ error: { message: 'bad key' } }, 401)]);

    await assert.rejects(agent.run('hi'), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 401);
        assert.match(err.body, /bad key/);
        return true;
    });
    assert.equal(fetchMock.mock.callCount(), 1);
});

test('429 is retried and then succeeds', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        jsonResponse({ error: 'rate limited' }, 429),
        completion(textMessage('ok'))
    ]);

    const result = await agent.run('hi');

    assert.equal(result.text, 'ok');
    assert.equal(fetchMock.mock.callCount(), 2);
});

test('502 (OpenRouter upstream failure) is retried and then succeeds', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        jsonResponse({ error: 'provider error' }, 502),
        completion(textMessage('ok'))
    ]);

    const result = await agent.run('hi');

    assert.equal(result.text, 'ok');
    assert.equal(fetchMock.mock.callCount(), 2);
});

test('requestTimeoutMs aborts a hanging request', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        });
    }));
    const agent = new Agent({
        transport: { apiKey: 'sk-test-key', model: 'test/model' },
        requestTimeoutMs: 25
    });

    await assert.rejects(agent.run('hi'), /timed out after 25ms/);
    assert.equal(fetchMock.mock.callCount(), 1);
});

test('constructor validates transport and options', () => {
    assert.throws(() => new Agent({}), /transport/);
    assert.throws(() => new Agent({ transport: { model: 'm' } }), /apiKey/);
    assert.throws(() => new Agent({ transport: { apiKey: 'k' } }), /model/);
    assert.throws(() => new Agent({ transport: { apiKey: 'k', model: 'm' }, maxSteps: 0 }), /maxSteps/);
    assert.throws(() => new Agent({ transport: { apiKey: 'k', model: 'm' }, onStep: 'nope' }), /onStep/);
});

test('registerTool validates tool shape and rejects duplicates', () => {
    const agent = new Agent({ transport: { apiKey: 'k', model: 'm' } });
    const valid = { name: 'x', description: 'd', parameters: { type: 'object' }, execute: async () => '' };

    agent.registerTool(valid);
    assert.throws(() => agent.registerTool(valid), /already registered/);
    assert.throws(() => agent.registerTool({ ...valid, name: 'bad name!' }), /tool.name/);
    assert.throws(() => agent.registerTool({ ...valid, name: 'y', description: '' }), /description/);
    assert.throws(() => agent.registerTool({ ...valid, name: 'y', parameters: null }), /parameters/);
    assert.throws(() => agent.registerTool({ ...valid, name: 'y', execute: null }), /execute/);
});

test('reasoning option is sent verbatim in every request body', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))], {
        reasoning: { enabled: true, max_tokens: 128 }
    });

    await agent.run('hi');

    assert.deepEqual(requestBody(fetchMock, 0).reasoning, { enabled: true, max_tokens: 128 });
});

test('explicit reasoning off is sent as given; omitted sends nothing', async (t) => {
    const off = makeAgent(t, [completion(textMessage('ok'))], { reasoning: { enabled: false } });
    await off.agent.run('hi');
    assert.deepEqual(requestBody(off.fetchMock, 0).reasoning, { enabled: false });

    const absent = makeAgent(t, [completion(textMessage('ok'))]);
    await absent.agent.run('hi');
    assert.equal(requestBody(absent.fetchMock, 0).reasoning, undefined);
});

test('reasoning is sent on every turn of a tool loop, not just the first', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'boom', arguments: '{}' } }] }),
        completion(textMessage('ok'))
    ], {
        reasoning: { enabled: true, max_tokens: 1268 },
        tools: [{
            name: 'boom', description: 'fails', parameters: { type: 'object' }, execute: async () => 'fine'
        }]
    });

    await agent.run('hi');

    assert.deepEqual(requestBody(fetchMock, 0).reasoning, { enabled: true, max_tokens: 1268 });
    assert.deepEqual(requestBody(fetchMock, 1).reasoning, { enabled: true, max_tokens: 1268 });
});

test('extraBody is shallow-merged last and can override defaults', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))], {
        reasoning: { enabled: true, max_tokens: 128 },
        extraBody: {
            temperature: 0.2,
            top_p: 0.9,
            max_tokens: 2000,
            provider: { order: ['relace'], allow_fallbacks: true }
        }
    });

    await agent.run('hi');

    const body = requestBody(fetchMock, 0);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.max_tokens, 2000);
    assert.deepEqual(body.provider, { order: ['relace'], allow_fallbacks: true });
    assert.deepEqual(body.reasoning, { enabled: true, max_tokens: 128 });
    assert.equal(body.stream, false); // rigline defaults still intact underneath
});

test('extraBody merged after reasoning can override it too', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [completion(textMessage('ok'))], {
        reasoning: { enabled: true, max_tokens: 128 },
        extraBody: { reasoning: { enabled: true, max_tokens: 4096 } }
    });

    await agent.run('hi');

    assert.deepEqual(requestBody(fetchMock, 0).reasoning, { enabled: true, max_tokens: 4096 });
});

test('constructor rejects invalid reasoning and extraBody', () => {
    const base = { transport: { apiKey: 'k', model: 'm' } };
    assert.throws(() => new Agent({ ...base, reasoning: 'low' }), /reasoning must be a plain object/);
    assert.throws(() => new Agent({ ...base, reasoning: null }), /reasoning must be a plain object/);
    assert.throws(() => new Agent({ ...base, extraBody: [] }), /extraBody must be a plain object/);
    assert.throws(() => new Agent({ ...base, extraBody: 'x' }), /extraBody must be a plain object/);
});
