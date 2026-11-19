import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, isRetryableStatus, delayForAttempt } from '../src/lib/retry.js';
import { jsonResponse } from './helpers.js';

const noSleep = async () => {};

function respond(t, queue) {
    return t.mock.method(globalThis, 'fetch', async () => {
        const next = queue.shift();
        if (next instanceof Error) {
            throw next;
        }
        return next;
    });
}

test('isRetryableStatus: 429 and 5xx only', () => {
    for (const status of [429, 500, 502, 503, 504]) {
        assert.equal(isRetryableStatus(status), true, `status ${status} should be retryable`);
    }
    for (const status of [200, 400, 401, 403, 404, 418, 422]) {
        assert.equal(isRetryableStatus(status), false, `status ${status} should not be retryable`);
    }
});

test('retries 429/5xx up to 3 total attempts, then returns the last response', async (t) => {
    const fetchMock = respond(t, [
        jsonResponse({}, 429),
        jsonResponse({}, 502),
        jsonResponse({}, 503)
    ]);
    const sleeps = [];

    const res = await fetchWithRetry('https://x.test', {}, { sleep: async (ms) => sleeps.push(ms) });

    assert.equal(res.status, 503);
    assert.equal(fetchMock.mock.callCount(), 3);
    assert.equal(sleeps.length, 2);
});

test('succeeds after a transient failure without exhausting attempts', async (t) => {
    const fetchMock = respond(t, [jsonResponse({}, 500), jsonResponse({ ok: 1 }, 200)]);

    const res = await fetchWithRetry('https://x.test', {}, { sleep: noSleep });

    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.callCount(), 2);
});

test('non-retryable status is returned immediately, no sleep', async (t) => {
    const fetchMock = respond(t, [jsonResponse({}, 400)]);
    let slept = 0;

    const res = await fetchWithRetry('https://x.test', {}, { sleep: async () => { slept += 1; } });

    assert.equal(res.status, 400);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(slept, 0);
});

test('network errors propagate immediately (not retried)', async (t) => {
    const fetchMock = respond(t, [new TypeError('fetch failed')]);

    await assert.rejects(
        fetchWithRetry('https://x.test', {}, { sleep: noSleep }),
        TypeError
    );
    assert.equal(fetchMock.mock.callCount(), 1);
});

test('abort errors propagate immediately (not retried)', async (t) => {
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = respond(t, [abortErr]);

    await assert.rejects(
        fetchWithRetry('https://x.test', {}, { sleep: noSleep }),
        (err) => err.name === 'AbortError'
    );
    assert.equal(fetchMock.mock.callCount(), 1);
});

test('backoff delays are exponential with 50-150% jitter and an 8s cap', () => {
    for (let i = 0; i < 200; i += 1) {
        const d0 = delayForAttempt(0, 500);   // 500 * [0.5, 1.5)
        assert.ok(d0 >= 250 && d0 <= 750, `attempt 0 out of bounds: ${d0}`);
        const d1 = delayForAttempt(1, 500);   // 1000 * [0.5, 1.5)
        assert.ok(d1 >= 500 && d1 <= 1500, `attempt 1 out of bounds: ${d1}`);
        const d3 = delayForAttempt(3, 500);   // 4000 (< cap)
        assert.ok(d3 >= 2000 && d3 <= 6000, `attempt 3 out of bounds: ${d3}`);
        const d5 = delayForAttempt(5, 500);   // capped at 8000
        assert.ok(d5 >= 4000 && d5 <= 12000, `attempt 5 out of bounds: ${d5}`);
    }
});
