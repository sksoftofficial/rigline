import test from 'node:test';
import assert from 'node:assert/strict';
import { websearchTool } from '../src/tools/index.js';
import {
    completion,
    textMessage,
    toolCallsMessage,
    toolCall,
    makeAgent,
    mockFetch,
    requestBody
} from './helpers.js';

const braveResponse = (results) => new Response(
    JSON.stringify({ type: 'search', web: { type: 'search', results } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
);

test('websearch queries Brave with the token header and renders opencode-style markdown', async (t) => {
    const fetchMock = mockFetch(t, [braveResponse([
        {
            title: 'Node.js 24 release notes',
            url: 'https://nodejs.org/en/blog/announcements/v24',
            description: 'Node.js 24 is now generally available.',
            date: '2025-04-23T10:00:00Z'
        },
        {
            title: 'Example — no date, plain description',
            url: 'https://example.com/node',
            description: 'A shorter write-up.'
        }
    ])]);
    const tool = websearchTool({ apiKey: 'BSA-key-1' });

    const out = await tool.execute({ query: 'node 24 release' });

    assert.equal(out, [
        '## [Node.js 24 release notes](https://nodejs.org/en/blog/announcements/v24)'
        + '\nPublished: 2025-04-23T10:00:00.000Z'
        + '\n\nNode.js 24 is now generally available.',
        '## [Example — no date, plain description](https://example.com/node)\n\nA shorter write-up.'
    ].join('\n\n'));

    const url = new URL(fetchMock.mock.calls[0].arguments[0]);
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(url.searchParams.get('q'), 'node 24 release');
    assert.equal(url.searchParams.get('count'), '8');
    assert.equal(url.searchParams.get('text_decorations'), 'false');
    const headers = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(headers['X-Subscription-Token'], 'BSA-key-1');
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers['Accept-Encoding'], 'gzip');
});

test('websearch: missing title falls back to the url, page_age maps to ISO, relative age is skipped', async (t) => {
    mockFetch(t, [braveResponse([
        { url: 'https://a.example/x', description: 'only url', page_age: '2025-06-01T12:30:42' },
        { title: 'Relative', url: 'https://b.example/y', description: 'recent', age: '1 day ago' }
    ])]);
    const tool = websearchTool({ apiKey: 'k' });

    // page_age has no timezone suffix — Date.parse reads it as local time,
    // so compute the expected ISO with the same conversion the tool uses.
    assert.equal(
        await tool.execute({ query: 'q' }),
        `## [https://a.example/x](https://a.example/x)\nPublished: ${new Date('2025-06-01T12:30:42').toISOString()}\n\nonly url`
        + '\n\n'
        + '## [Relative](https://b.example/y)\n\nrecent'
    );
});

test('websearch: no results (or no web block) returns the teaching message', async (t) => {
    const tool = websearchTool({ apiKey: 'k' });

    mockFetch(t, [braveResponse([])]);
    assert.equal(await tool.execute({ query: 'zzz' }), 'No search results found. Please try a different query.');

    mockFetch(t, [new Response(JSON.stringify({ type: 'search' }), { headers: { 'content-type': 'application/json' } })]);
    assert.equal(await tool.execute({ query: 'zzz' }), 'No search results found. Please try a different query.');
});

test('websearch maps 429/401 to teaching errors and other statuses to a plain failure', async (t) => {
    const tool = websearchTool({ apiKey: 'k' });

    mockFetch(t, [new Response('rate', { status: 429 })]);
    await assert.rejects(tool.execute({ query: 'q' }), /Web search rate limited \(HTTP 429\)$/);

    mockFetch(t, [new Response('nope', { status: 401 })]);
    await assert.rejects(tool.execute({ query: 'q' }), /Web search authentication failed \(HTTP 401\)$/);

    mockFetch(t, [new Response('boom', { status: 500 })]);
    await assert.rejects(tool.execute({ query: 'q' }), /Web search request failed \(HTTP 500\)$/);
});

test('websearch times out with a clear error', async (t) => {
    t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
        });
    }));
    const tool = websearchTool({ apiKey: 'k', timeoutMs: 50 });

    await assert.rejects(
        tool.execute({ query: 'slow' }),
        /Unable to search the web for "slow": request timed out after 0s|request timed out/
    );
});

test('websearch validates query input and never hits the network on failure', async (t) => {
    const fetchMock = mockFetch(t, []);
    const tool = websearchTool({ apiKey: 'k' });

    await assert.rejects(tool.execute({}), /query must be a non-empty string/);
    await assert.rejects(tool.execute({ query: '' }), /query must be a non-empty string/);
    assert.equal(fetchMock.mock.calls.length, 0);
});

test('websearch factory options: apiKey required, count clamped 1..20, country/searchLang passthrough', async (t) => {
    assert.throws(() => websearchTool({}), /requires an apiKey option/);
    assert.throws(() => websearchTool({ apiKey: '' }), /requires an apiKey option/);
    assert.throws(() => websearchTool({ apiKey: 'k', count: 21 }), /count must be an integer between 1 and 20/);
    assert.throws(() => websearchTool({ apiKey: 'k', count: 0 }), /count must be an integer between 1 and 20/);
    assert.throws(() => websearchTool({ apiKey: 'k', country: '' }), /country must be a non-empty/);
    assert.throws(() => websearchTool({ apiKey: 'k', searchLang: '' }), /searchLang must be a non-empty/);
    assert.throws(() => websearchTool({ apiKey: 'k', timeoutMs: 0 }), /timeoutMs must be a positive number/);

    const fetchMock = mockFetch(t, [braveResponse([{ title: 't', url: 'https://x.example/' }])]);
    const tool = websearchTool({ apiKey: 'k', count: 3, country: 'de', searchLang: 'tr' });

    await tool.execute({ query: 'q' });
    const url = new URL(fetchMock.mock.calls[0].arguments[0]);
    assert.equal(url.searchParams.get('count'), '3');
    assert.equal(url.searchParams.get('country'), 'de');
    assert.equal(url.searchParams.get('search_lang'), 'tr');
});

test('websearch runs inside an agent loop and returns results to the model', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'websearch', { query: 'rigline node agent' })])),
        braveResponse([
            { title: 'rigline', url: 'https://rigline.example/', description: 'Embeddable agent harness.' }
        ]),
        completion(textMessage('summarized'))
    ], { tools: [websearchTool({ apiKey: 'k' })] });

    const result = await agent.run('search for rigline');

    assert.equal(result.text, 'summarized');
    const toolMessage = requestBody(fetchMock, 2).messages.find((m) => m.role === 'tool');
    assert.equal(
        toolMessage.content,
        '## [rigline](https://rigline.example/)\n\nEmbeddable agent harness.'
    );
});
