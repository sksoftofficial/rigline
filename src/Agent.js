import { fetchWithRetry } from './lib/retry.js';
import { Workspace } from './workspace.js';
import { readTool, writeTool, editTool, patchTool, globTool, grepTool } from './tools/index.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MAX_STEPS = 24;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const RETRY_MAX_ATTEMPTS = 3;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class MaxStepsError extends Error {
    constructor(maxSteps, messages) {
        super(`Agent exceeded maxSteps (${maxSteps}) without producing a final answer`);
        this.name = 'MaxStepsError';
        this.maxSteps = maxSteps;
        this.messages = messages;
    }
}

export class ApiError extends Error {
    constructor(status, url, body) {
        const snippet = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body ?? '').slice(0, 500);
        super(`Provider request failed with status ${status} (POST ${url}): ${snippet}`);
        this.name = 'ApiError';
        this.status = status;
        this.url = url;
        this.body = body;
    }
}

export class JsonParseError extends Error {
    constructor(raw, result) {
        super('Agent final answer is not valid JSON');
        this.name = 'JsonParseError';
        this.raw = raw;
        this.result = result;
    }
}

function formatToolOutput(output) {
    if (typeof output === 'string') {
        return output;
    }
    if (output === undefined || output === null) {
        return '';
    }
    try {
        return JSON.stringify(output);
    } catch {
        return String(output);
    }
}

function accumulateUsage(total, raw) {
    if (!raw || typeof raw !== 'object') {
        return;
    }
    total.promptTokens += raw.prompt_tokens ?? 0;
    total.completionTokens += raw.completion_tokens ?? 0;
    if (typeof raw.cost === 'number') {
        total.cost = (total.cost ?? 0) + raw.cost;
    }
}

function snapshotUsage(total) {
    const usage = { promptTokens: total.promptTokens, completionTokens: total.completionTokens };
    if (typeof total.cost === 'number') {
        usage.cost = total.cost;
    }
    return usage;
}

export class Agent {
    #transport;
    #systemPrompt;
    #maxSteps;
    #requestTimeoutMs;
    #reasoning;
    #extraBody;
    #onStep;
    #workspace;
    #tools = new Map();

    constructor(options = {}) {
        const {
            transport,
            systemPrompt,
            tools,
            sandboxed,
            maxSteps = DEFAULT_MAX_STEPS,
            requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
            reasoning,
            extraBody,
            onStep
        } = options;

        if (!transport || typeof transport !== 'object') {
            throw new TypeError('Agent requires a transport option: { apiKey, model, baseUrl?, headers? }');
        }
        if (typeof transport.apiKey !== 'string' || transport.apiKey.length === 0) {
            throw new TypeError('transport.apiKey is required (string)');
        }
        if (typeof transport.model !== 'string' || transport.model.length === 0) {
            throw new TypeError('transport.model is required (string)');
        }
        if (transport.headers !== undefined && (transport.headers === null || Array.isArray(transport.headers) || typeof transport.headers !== 'object')) {
            throw new TypeError('transport.headers must be a plain object of header name -> value');
        }
        if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
            throw new TypeError('maxSteps must be an integer >= 1');
        }
        if (requestTimeoutMs !== undefined && (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)) {
            throw new TypeError('requestTimeoutMs must be a positive number of milliseconds');
        }
        if (onStep !== undefined && typeof onStep !== 'function') {
            throw new TypeError('onStep must be a function');
        }
        if (reasoning !== undefined && (reasoning === null || Array.isArray(reasoning) || typeof reasoning !== 'object')) {
            throw new TypeError('reasoning must be a plain object, e.g. { enabled: true, max_tokens: 128 }');
        }
        if (extraBody !== undefined && (extraBody === null || Array.isArray(extraBody) || typeof extraBody !== 'object')) {
            throw new TypeError('extraBody must be a plain object merged into each request body');
        }
        if (sandboxed !== undefined && sandboxed !== true && (typeof sandboxed !== 'string' || sandboxed.trim().length === 0)) {
            throw new TypeError('sandboxed must be true or a workspace directory path string');
        }

        this.#transport = {
            apiKey: transport.apiKey,
            model: transport.model,
            baseUrl: (transport.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
            headers: transport.headers ?? {}
        };
        this.#systemPrompt = systemPrompt;
        this.#maxSteps = maxSteps;
        this.#requestTimeoutMs = requestTimeoutMs;
        this.#reasoning = reasoning;
        this.#extraBody = extraBody ?? {};
        this.#onStep = onStep;

        for (const tool of tools ?? []) {
            this.registerTool(tool);
        }

        if (sandboxed !== undefined) {
            for (const name of ['read', 'write', 'edit', 'patch', 'glob', 'grep']) {
                if (this.#tools.has(name)) {
                    throw new Error(`sandboxed already registers the built-in '${name}' tool scoped to the session workspace; do not also pass your own tools with those names`);
                }
            }
            this.#workspace = new Workspace(typeof sandboxed === 'string' ? sandboxed : undefined);
        }
    }

    // Host-side helpers (put/get/getBytes/list/exists/dir) for the sandbox
    // session workspace; undefined unless the agent was built with `sandboxed`.
    get workspace() {
        return this.#workspace?.api;
    }

    registerTool(tool) {
        if (!tool || typeof tool !== 'object') {
            throw new TypeError('tool must be an object: { name, description, parameters, execute }');
        }
        if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)) {
            throw new TypeError('tool.name must be a string matching /^[a-zA-Z0-9_-]{1,64}$/');
        }
        if (typeof tool.description !== 'string' || tool.description.length === 0) {
            throw new TypeError(`tool.description is required (string), for tool '${tool.name}'`);
        }
        if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
            throw new TypeError(`tool.parameters must be a JSON Schema object, for tool '${tool.name}'`);
        }
        if (typeof tool.execute !== 'function') {
            throw new TypeError(`tool.execute must be a function, for tool '${tool.name}'`);
        }
        if (this.#tools.has(tool.name)) {
            throw new Error(`Tool already registered: '${tool.name}'`);
        }
        this.#tools.set(tool.name, {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            execute: tool.execute
        });
    }

    // input: prompt string (systemPrompt is prepended) OR a messages array,
    // used verbatim — this is how a conversation continues via result.messages.
    // With `sandboxed`, each call is one session: a fresh session-* folder the
    // built-in tools are scoped to, removed just before the run settles.
    async run(input) {
        const messages = this.#buildMessages(input);
        const session = this.#workspace?.startSession();
        if (session) {
            this.#tools.set('read', readTool({ root: session.dir }));
            this.#tools.set('write', writeTool({ root: session.dir }));
            this.#tools.set('edit', editTool({ root: session.dir }));
            this.#tools.set('patch', patchTool({ root: session.dir }));
            this.#tools.set('glob', globTool({ root: session.dir }));
            this.#tools.set('grep', grepTool({ root: session.dir }));
        }
        let steps = 0;
        const totalUsage = { promptTokens: 0, completionTokens: 0, cost: undefined };

        try {
            for (;;) {
                if (steps >= this.#maxSteps) {
                    throw new MaxStepsError(this.#maxSteps, messages);
                }

                const data = await this.#request(messages);
                accumulateUsage(totalUsage, data.usage);
                steps += 1;

                const message = data.choices?.[0]?.message;
                if (!message || typeof message !== 'object') {
                    const err = new Error(`Unexpected provider response (missing choices[0].message): ${JSON.stringify(data).slice(0, 500)}`);
                    err.name = 'UnexpectedResponseError';
                    throw err;
                }
                messages.push(message);

                const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                if (toolCalls.length === 0) {
                    const usage = snapshotUsage(totalUsage);
                    const result = {
                        text: typeof message.content === 'string' ? message.content : '',
                        messages,
                        steps,
                        usage
                    };
                    this.#onStep?.({ step: steps, message, toolResults: [], usage });
                    return result;
                }

                const toolResults = [];
                for (const call of toolCalls) {
                    const content = await this.#executeToolCall(call);
                    toolResults.push({ toolCallId: call?.id, name: call?.function?.name, content });
                    messages.push({ role: 'tool', tool_call_id: call?.id, content });
                }
                this.#onStep?.({ step: steps, message, toolResults, usage: snapshotUsage(totalUsage) });
            }
        } finally {
            await session?.end();
        }
    }

    // Same as run(), but the final text is JSON.parse'd and the parsed value is
    // returned. On parse failure throws JsonParseError with .raw (model text)
    // and .result (the full run result). Parsing is strict — code fences are
    // not stripped.
    async runJson(input) {
        const result = await this.run(input);
        try {
            return JSON.parse(result.text);
        } catch (cause) {
            throw new JsonParseError(result.text, result, { cause });
        }
    }

    #buildMessages(input) {
        if (Array.isArray(input)) {
            if (input.length === 0) {
                throw new TypeError('run() messages array must not be empty');
            }
            return [...input];
        }
        if (typeof input !== 'string') {
            throw new TypeError('run() input must be a prompt string or a messages array');
        }
        const messages = [];
        if (this.#systemPrompt) {
            messages.push({ role: 'system', content: this.#systemPrompt });
        }
        messages.push({ role: 'user', content: input });
        return messages;
    }

    // A throwing execute (or unknown tool, or malformed arguments) never aborts
    // the run: the message goes back to the model as `Error: <message>`.
    async #executeToolCall(call) {
        const name = call?.function?.name;
        try {
            const tool = this.#tools.get(name);
            if (!tool) {
                throw new Error(`Unknown tool '${name}'`);
            }
            let args;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch {
                throw new Error(`Invalid JSON arguments for tool '${name}': ${call.function.arguments}`);
            }
            const output = await tool.execute(args);
            return formatToolOutput(output);
        } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    async #request(messages) {
        const url = `${this.#transport.baseUrl}/chat/completions`;
        const body = { model: this.#transport.model, messages, stream: false };
        if (this.#tools.size > 0) {
            body.tools = [...this.#tools.values()].map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                }
            }));
        }
        if (this.#reasoning !== undefined) {
            body.reasoning = this.#reasoning;
        }
        // extraBody is merged last and can override anything above it.
        Object.assign(body, this.#extraBody);

        // One AbortController per logical request; the timeout spans all retry attempts.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
        let response;
        try {
            response = await fetchWithRetry(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.#transport.apiKey}`,
                    ...this.#transport.headers
                },
                body: JSON.stringify(body),
                signal: controller.signal
            }, { maxAttempts: RETRY_MAX_ATTEMPTS });
        } catch (err) {
            if (err?.name === 'AbortError') {
                throw new Error(`Provider request timed out after ${this.#requestTimeoutMs}ms (POST ${url})`, { cause: err });
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ApiError(response.status, url, text);
        }
        try {
            return await response.json();
        } catch {
            throw new ApiError(response.status, url, '<body was not valid JSON>');
        }
    }
}
