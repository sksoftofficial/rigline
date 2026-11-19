// Ported from opencode's webfetch tool: fetch an HTTP(S) URL and return it
// as markdown (default), text, or HTML. Redirects are followed manually so
// every hop is re-validated; the body is capped in memory; only textual
// content types are accepted. Not root-confined — it is a network tool, so
// it is NOT auto-registered by `sandboxed` (hosts opt in explicitly).

import { convertHTMLToMarkdown, extractTextFromHTML } from '../lib/html-to-markdown.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_REDIRECTS = 10;
const FORMATS = ['text', 'markdown', 'html'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Rigline-User/1.0';
// Cloudflare challenges browser-like user agents harder; a plain client
// agent sometimes passes (opencode retries the same way).
const CHALLENGE_USER_AGENT = 'rigline';

const ACCEPT_HEADERS = {
    markdown: 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
    text: 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1',
    html: 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1'
};

const mimeFrom = (contentType) => contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
const isImageAttachment = (mime) =>
    mime.startsWith('image/') && mime !== 'image/svg+xml' && mime !== 'image/vnd.fastbidsheet';
const isTextual = (mime) =>
    !mime
    || mime.startsWith('text/')
    || mime === 'application/json'
    || mime.endsWith('+json')
    || mime === 'application/xml'
    || mime.endsWith('+xml')
    || mime === 'application/javascript'
    || mime === 'application/x-javascript';

function assertHttpUrl(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('URL must use http:// or https://');
    }
    // Rules match the URL, so `https://user@evil.com` would slip past a rule for `https://evil.com/*`.
    if (url.username || url.password) {
        throw new Error('URL must not include credentials');
    }
}

function convert(content, contentType, format) {
    if (!contentType.includes('text/html')) {
        return content;
    }
    if (format === 'markdown') {
        return convertHTMLToMarkdown(content);
    }
    if (format === 'text') {
        return extractTextFromHTML(content);
    }
    return content;
}

async function collectBoundedResponseBody(response, maxBytes) {
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isSafeInteger(declared) && declared >= 0 && declared > maxBytes) {
        throw new Error(`Response too large (exceeds ${maxBytes} byte limit)`);
    }
    if (!response.body) {
        return new Uint8Array(0);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (size + value.byteLength > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Response too large (exceeds ${maxBytes} byte limit)`);
        }
        chunks.push(value);
        size += value.byteLength;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

export function webfetchTool(options = {}) {
    if (options.userAgent !== undefined && (typeof options.userAgent !== 'string' || options.userAgent.length === 0)) {
        throw new TypeError('webfetchTool requires a non-empty userAgent string when provided');
    }
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    const requestHeaders = (format) => ({
        'User-Agent': userAgent,
        Accept: ACCEPT_HEADERS[format],
        'Accept-Language': 'en-US,en;q=0.9'
    });

    return {
        name: 'webfetch',
        description: 'Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default. Only textual content is supported (HTML, plain text, JSON, XML, ...); images and binary files are rejected. Redirects are followed (up to 10) and must stay on http/https. Use a more targeted tool when one is available. This tool is read-only.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch content from' },
                format: { type: 'string', enum: FORMATS, description: "The format to return the content in. Defaults to 'markdown'." },
                timeout: { type: 'number', description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})` }
            },
            required: ['url'],
            additionalProperties: false
        },
        execute: async (args) => {
            if (typeof args?.url !== 'string' || args.url.length === 0) {
                throw new Error('url must be a non-empty string');
            }
            const format = args?.format ?? 'markdown';
            if (!FORMATS.includes(format)) {
                throw new Error(`format must be one of: ${FORMATS.join(', ')}`);
            }
            if (args?.timeout !== undefined
                && (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > MAX_TIMEOUT_SECONDS)) {
                throw new Error(`timeout must be a number of seconds between 0 (exclusive) and ${MAX_TIMEOUT_SECONDS}`);
            }
            const timeoutSeconds = args?.timeout ?? DEFAULT_TIMEOUT_SECONDS;
            // The fragment is never sent; stripping it keeps URLs canonical for rule matching.
            const url = args.url.split('#')[0];

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
            try {
                return await fetchDocument(url, format, controller.signal, requestHeaders);
            } catch (err) {
                if (err?.name === 'AbortError') {
                    throw new Error(`Unable to fetch ${args.url}: request timed out after ${timeoutSeconds}s`);
                }
                const detail = err?.cause?.message ? `fetch failed (${err.cause.message})` : err?.message ?? String(err);
                throw new Error(`Unable to fetch ${args.url}: ${detail}`);
            } finally {
                clearTimeout(timer);
            }
        }
    };
}

// One controller spans every hop (and the Cloudflare retry), like the agent's
// own requestTimeoutMs — the timeout is for the whole document, not per hop.
async function fetchDocument(url, format, signal, requestHeaders) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('invalid URL');
    }
    assertHttpUrl(parsed);

    let current = parsed.href;
    for (let redirects = 0;; redirects += 1) {
        let response = await fetchOnce(current, format, signal, requestHeaders);
        const location = response.headers.get('location');
        if (REDIRECT_STATUSES.has(response.status) && location) {
            await response.body?.cancel().catch(() => {});
            if (redirects >= MAX_REDIRECTS) {
                throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
            }
            const target = new URL(location, current);
            assertHttpUrl(target);
            target.hash = '';
            current = target.href;
            continue;
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`response status ${response.status}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        const mime = mimeFrom(contentType);
        if (isImageAttachment(mime)) {
            throw new Error(`unsupported fetched image content type: ${mime}`);
        }
        if (!isTextual(mime)) {
            throw new Error(`unsupported fetched file content type: ${mime}`);
        }
        const body = await collectBoundedResponseBody(response, MAX_RESPONSE_BYTES);
        return convert(new TextDecoder().decode(body), contentType, format);
    }
}

async function fetchOnce(url, format, signal, requestHeaders) {
    // redirect: 'manual' — each hop goes through assertHttpUrl again.
    let response = await fetch(url, { redirect: 'manual', signal, headers: requestHeaders(format) });
    const challenged = response.status === 403 && response.headers.get('cf-mitigated') === 'challenge';
    if (challenged) {
        await response.body?.cancel().catch(() => {});
        response = await fetch(url, {
            redirect: 'manual',
            signal,
            headers: { ...requestHeaders(format), 'User-Agent': CHALLENGE_USER_AGENT }
        });
    }
    return response;
}
