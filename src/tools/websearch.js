// Web search tool on the Brave Search API, with opencode's websearch tool
// shape and output format but Brave as the only provider (opencode's
// provider registry, forms and Tavily/Exa/... integrations are deliberately
// not inherited). The API key is passed at construction — the host reads its
// own env/config and injects it here; rigline never reads env itself.
// Network-scoped like webfetch: not root-confined, NOT auto-registered by
// `sandboxed` (hosts opt in via `tools`).

const SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 25000;

const NO_RESULTS = 'No search results found. Please try a different query.';
// opencode's teaching errors, kept verbatim — the model can act on these.
const HTTP_ERRORS = new Map([
    [429, 'Web search rate limited (HTTP 429)'],
    [401, 'Web search authentication failed (HTTP 401)']
]);

export function websearchTool(options = {}) {
    const {
        apiKey,
        count = DEFAULT_COUNT,
        country,
        searchLang,
        timeoutMs = DEFAULT_TIMEOUT_MS
    } = options ?? {};

    if (typeof apiKey !== 'string' || apiKey.length === 0) {
        throw new TypeError('websearchTool requires an apiKey option: the Brave Search API key (X-Subscription-Token)');
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        throw new TypeError(`count must be an integer between 1 and ${MAX_COUNT}`);
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new TypeError('timeoutMs must be a positive number of milliseconds');
    }
    if (country !== undefined && (typeof country !== 'string' || country.length === 0)) {
        throw new TypeError('country must be a non-empty ISO 3166-1 alpha-2 code string when provided');
    }
    if (searchLang !== undefined && (typeof searchLang !== 'string' || searchLang.length === 0)) {
        throw new TypeError('searchLang must be a non-empty search language code string when provided');
    }

    return {
        name: 'websearch',
        description: `Search the web using Brave Search. Use this for current information beyond knowledge cutoff.\n\nThe current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Websearch query' }
            },
            required: ['query'],
            additionalProperties: false
        },
        execute: async (args) => {
            if (typeof args?.query !== 'string' || args.query.length === 0) {
                throw new Error('query must be a non-empty string');
            }
            const query = args.query;

            const params = new URLSearchParams({
                q: query,
                count: String(count),
                // plain-text descriptions — Brave decorates them with <strong>
                // highlight markup by default, which is noise in markdown output
                text_decorations: 'false'
            });
            if (country !== undefined) {
                params.set('country', country);
            }
            if (searchLang !== undefined) {
                params.set('search_lang', searchLang);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response;
            try {
                response = await fetch(`${SEARCH_URL}?${params}`, {
                    signal: controller.signal,
                    headers: {
                        Accept: 'application/json',
                        'Accept-Encoding': 'gzip',
                        'X-Subscription-Token': apiKey
                    }
                });
            } catch (err) {
                if (err?.name === 'AbortError') {
                    throw new Error(`Unable to search the web for "${query}": request timed out after ${Math.round(timeoutMs / 1000)}s`);
                }
                const detail = err?.cause?.message ? `fetch failed (${err.cause.message})` : err?.message ?? String(err);
                throw new Error(`Unable to search the web for "${query}": ${detail}`);
            } finally {
                clearTimeout(timer);
            }

            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                const teaching = HTTP_ERRORS.get(response.status);
                throw new Error(teaching ?? `Web search request failed (HTTP ${response.status})`);
            }

            let data;
            try {
                data = await response.json();
            } catch {
                throw new Error(`Unable to search the web for "${query}": response was not valid JSON`);
            }

            const results = Array.isArray(data?.web?.results) ? data.web.results : [];
            if (results.length === 0) {
                return NO_RESULTS;
            }

            // opencode's entry format: ## [title](url) + optional Published
            // ISO line + content, entries separated by a blank line. Brave's
            // date fields are ISO-ish (date / page_age); the relative `age`
            // string is skipped rather than mangled into a fake timestamp.
            return results.map((result) => {
                const title = typeof result?.title === 'string' && result.title ? result.title : result?.url ?? '';
                const raw = typeof result?.date === 'string' && result.date
                    ? result.date
                    : (typeof result?.page_age === 'string' ? result.page_age : '');
                const parsed = raw ? Date.parse(raw) : Number.NaN;
                const published = Number.isNaN(parsed) ? '' : `\nPublished: ${new Date(parsed).toISOString()}`;
                const content = typeof result?.description === 'string' && result.description
                    ? `\n\n${result.description}`
                    : '';
                return `## [${title}](${result?.url ?? ''})${published}${content}`;
            }).join('\n\n');
        }
    };
}
