const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

export function isRetryableStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
}

// Exponential backoff with 50-150% jitter, capped at MAX_DELAY_MS.
// attempt is 0-based: 0 -> first retry, 1 -> second, ...
export function delayForAttempt(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS) {
    const exponential = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** attempt);
    return Math.round(exponential * (0.5 + Math.random()));
}

function defaultSleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// POST helper with a bounded retry ladder for 429/5xx responses.
// Network errors and aborts propagate immediately (not retried): only
// retryable HTTP statuses consume another attempt.
export async function fetchWithRetry(url, init = {}, options = {}) {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const sleep = options.sleep ?? defaultSleep;

    for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(url, init);
        if (!isRetryableStatus(response.status) || attempt >= maxAttempts - 1) {
            return response;
        }
        await sleep(delayForAttempt(attempt, baseDelayMs));
    }
}
