import test from 'node:test';
import assert from 'node:assert/strict';
import { webfetchTool } from '../src/tools/index.js';
import { Agent } from '../src/Agent.js';
import {
    completion,
    textMessage,
    toolCallsMessage,
    toolCall,
    makeAgent,
    mockFetch,
    requestBody
} from './helpers.js';

const MAX_BYTES = 5 * 1024 * 1024;

const htmlResponse = (body, headers = {}) =>
    new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const redirectResponse = (location) =>
    new Response(null, { status: 301, headers: { location } });

test('webfetch fetches with markdown defaults: fragment stripped, manual redirects, accept headers', async (t) => {
    const fetchMock = mockFetch(t, [htmlResponse('<html><body><h1>Hi</h1></body></html>')]);
    const tool = webfetchTool();

    assert.equal(await tool.execute({ url: 'https://example.com/page#section' }), '# Hi');

    const call = fetchMock.mock.calls[0];
    assert.equal(call.arguments[0], 'https://example.com/page');
    assert.equal(call.arguments[1].redirect, 'manual');
    assert.equal(call.arguments[1].headers.Accept.startsWith('text/markdown;q=1.0'), true);
    assert.equal(call.arguments[1].headers['Accept-Language'], 'en-US,en;q=0.9');
    assert.equal(call.arguments[1].headers['User-Agent'].includes('Rigline'), true);
});

test('webfetch format=text extracts text and format=html returns the body verbatim', async (t) => {
    const body = '<p>Hello <b>world</b></p><script>x()</script>';
    const text = mockFetch(t, [htmlResponse(body)]);
    const tool = webfetchTool();

    assert.equal(await tool.execute({ url: 'https://example.com/a', format: 'text' }), 'Hello world');
    assert.equal(text.mock.calls[0].arguments[1].headers.Accept.startsWith('text/plain;q=1.0'), true);

    mockFetch(t, [htmlResponse(body)]);
    assert.equal(await tool.execute({ url: 'https://example.com/a', format: 'html' }), body);
});

test('webfetch passes non-HTML textual content through verbatim regardless of format', async (t) => {
    mockFetch(t, [new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })]);
    const tool = webfetchTool();

    assert.equal(await tool.execute({ url: 'https://api.example.com/v1' }), '{"ok":true}');
});

test('webfetch follows redirects manually, resolving relative locations and stripping hashes', async (t) => {
    const fetchMock = mockFetch(t, [
        redirectResponse('/next#frag'),
        htmlResponse('<p>arrived</p>')
    ]);
    const tool = webfetchTool();

    assert.equal(await tool.execute({ url: 'https://example.com/start' }), 'arrived');
    assert.equal(fetchMock.mock.calls[1].arguments[0], 'https://example.com/next');
});

test('webfetch rejects redirects away from http/https and caps the redirect count', async (t) => {
    const ftp = mockFetch(t, [redirectResponse('ftp://evil.example/x')]);
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/start' }),
        /Unable to fetch https:\/\/example\.com\/start: URL must use http:\/\/ or https:\/\/$/
    );
    assert.equal(ftp.mock.calls.length, 1);

    const loop = mockFetch(t, Array.from({ length: 11 }, () => redirectResponse('/loop')));
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/loop' }),
        /too many redirects \(more than 10\)/
    );
    assert.equal(loop.mock.calls.length, 11);
});

test('webfetch fails non-2xx responses with the status', async (t) => {
    mockFetch(t, [new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })]);
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/missing' }),
        /Unable to fetch https:\/\/example\.com\/missing: response status 404$/
    );
});

test('webfetch rejects non-textual content types with teaching errors', async (t) => {
    mockFetch(t, [new Response(Buffer.from([0x89, 0x50]), { headers: { 'content-type': 'image/png' } })]);
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/img.png' }),
        /unsupported fetched image content type: image\/png$/
    );

    mockFetch(t, [new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })]);
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/doc.pdf' }),
        /unsupported fetched file content type: application\/pdf$/
    );

    mockFetch(t, [new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })]);
    // +xml is textual in opencode's rules too — SVG markup fetches verbatim
    assert.equal(await webfetchTool().execute({ url: 'https://example.com/icon.svg' }), '<svg/>');
});

test('webfetch enforces the response size limit via content-length and streamed bytes', async (t) => {
    mockFetch(t, [htmlResponse('x', { 'content-length': String(MAX_BYTES + 1) })]);
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/big' }),
        new RegExp(`Response too large \\(exceeds ${MAX_BYTES} byte limit\\)`)
    );

    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream({
        start(controller) {
            for (let i = 0; i < 6; i += 1) {
                controller.enqueue(chunk);
            }
            controller.close();
        }
    });
    mockFetch(t, [new Response(stream, { headers: { 'content-type': 'text/plain' } })]);
    await assert.rejects(
        webfetchTool().execute({ url: 'https://example.com/chunked' }),
        /Response too large/
    );
});

test('webfetch validates url, format, and timeout inputs', async (t) => {
    const fetchMock = mockFetch(t, []);
    const tool = webfetchTool();

    await assert.rejects(tool.execute({}), /url must be a non-empty string/);
    await assert.rejects(tool.execute({ url: 'https://a.example/', format: 'xml' }), /format must be one of: text, markdown, html/);
    await assert.rejects(tool.execute({ url: 'https://a.example/', timeout: 0 }), /timeout must be a number of seconds/);
    await assert.rejects(tool.execute({ url: 'https://a.example/', timeout: 121 }), /timeout must be a number of seconds/);
    await assert.rejects(tool.execute({ url: 'https://a.example/', timeout: '30' }), /timeout must be a number of seconds/);
    await assert.rejects(tool.execute({ url: 'not a url' }), /Unable to fetch not a url: invalid URL/);
    await assert.rejects(tool.execute({ url: 'ftp://example.com/f' }), /URL must use http:\/\/ or https:\/\/$/);
    await assert.rejects(tool.execute({ url: 'https://u:p@example.com/' }), /URL must not include credentials/);
    assert.equal(fetchMock.mock.calls.length, 0, 'validation failures must not hit the network');
});

test('webfetch times out and reports the elapsed budget', async (t) => {
    t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
        });
    }));

    await assert.rejects(
        webfetchTool().execute({ url: 'https://slow.example/', timeout: 0.05 }),
        /Unable to fetch https:\/\/slow\.example\/: request timed out after 0\.05s$/
    );
});

test('webfetch retries Cloudflare challenges once with a plain client user agent', async (t) => {
    const fetchMock = mockFetch(t, [
        new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
        htmlResponse('<p>ok</p>')
    ]);
    const tool = webfetchTool();

    assert.equal(await tool.execute({ url: 'https://shielded.example/' }), 'ok');
    assert.equal(fetchMock.mock.calls[1].arguments[1].headers['User-Agent'], 'rigline');
});

test('webfetch honors a custom userAgent option', async (t) => {
    const fetchMock = mockFetch(t, [htmlResponse('<p>x</p>')]);
    const tool = webfetchTool({ userAgent: 'MyBot/1.0' });

    await tool.execute({ url: 'https://example.com/' });
    assert.equal(fetchMock.mock.calls[0].arguments[1].headers['User-Agent'], 'MyBot/1.0');
    assert.throws(() => webfetchTool({ userAgent: '' }), /non-empty userAgent string/);
});

test('webfetch runs inside an agent loop and returns converted content to the model', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'webfetch', { url: 'https://example.com/doc' })])),
        htmlResponse('<h2>Doc</h2>'),
        completion(textMessage('done'))
    ], { tools: [webfetchTool()] });

    const result = await agent.run('fetch the doc');

    assert.equal(result.text, 'done');
    const toolMessage = requestBody(fetchMock, 2).messages.find((m) => m.role === 'tool');
    assert.equal(toolMessage.content, '## Doc');
});

test('webfetch is network-scoped, not filesystem-scoped: registers fine next to the built-in file tools', () => {
    const transport = { apiKey: 'k', model: 'm' };
    const agent = new Agent({ transport, tools: [webfetchTool()] });
    assert.equal(typeof agent.workspace.put, 'function');
});
