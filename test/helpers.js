import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Agent } from '../src/Agent.js';

export function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function textResponse(text, status = 200) {
    return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
}

export function textMessage(content) {
    return { role: 'assistant', content };
}

export function toolCallsMessage(calls) {
    return { role: 'assistant', content: null, tool_calls: calls };
}

export function toolCall(id, name, args) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

export function completion(message, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
    return {
        id: 'cmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage
    };
}

// Installs a mocked global fetch that replies with the queued responses in order.
// Entries may be Response objects, plain completion body objects (auto-wrapped as
// JSON 200), Error instances (thrown), or () => Response.
export function mockFetch(t, responses) {
    const queue = [...responses];
    return t.mock.method(globalThis, 'fetch', async () => {
        const next = queue.shift();
        if (next === undefined) {
            throw new Error('unexpected extra fetch call (mock response queue is empty)');
        }
        if (typeof next === 'function') {
            return next();
        }
        if (next instanceof Error) {
            throw next;
        }
        if (next instanceof Response) {
            return next;
        }
        return jsonResponse(next);
    });
}

export function requestUrl(fetchMock, index) {
    return fetchMock.mock.calls[index].arguments[0];
}

export function requestHeaders(fetchMock, index) {
    return fetchMock.mock.calls[index].arguments[1].headers;
}

export function requestBody(fetchMock, index) {
    return JSON.parse(fetchMock.mock.calls[index].arguments[1].body);
}

export function tempRoot(t) {
    const dir = mkdtempSync(join(tmpdir(), 'rigline-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

export function put(root, relPath, content) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return target;
}

export function makeAgent(t, responses, options = {}) {
    const fetchMock = mockFetch(t, responses);
    const { transport, ...rest } = options;
    const agent = new Agent({
        transport: { apiKey: 'sk-test-key', model: 'test/model', ...transport },
        ...rest
    });
    return { agent, fetchMock };
}
