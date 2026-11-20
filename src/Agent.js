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

// Usage detail readers mirror sevgili-backend's normalizeUsage ladder: the
// plain name first, then the OpenAI/OpenRouter details objects, then the
// Anthropic-style names. reasoning is a subset of completionTokens (billed
// thinking); cached is a subset of promptTokens (cache hits).
function parseTokenCount(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function readReasoningTokens(raw) {
    return parseTokenCount(
        raw.reasoning_tokens
        ?? raw.completion_tokens_details?.reasoning_tokens
        ?? raw.output_tokens_details?.reasoning_tokens
    );
}

function readCachedTokens(raw) {
    return parseTokenCount(
        raw.cached_tokens
        ?? raw.prompt_tokens_details?.cached_tokens
        ?? raw.cache_read_input_tokens
    );
}

function accumulateUsage(total, raw) {
    if (!raw || typeof raw !== 'object') {
        return;
    }
    const prompt = raw.prompt_tokens ?? 0;
    const completion = raw.completion_tokens ?? 0;
    total.promptTokens += prompt;
    total.completionTokens += completion;
    total.totalTokens += raw.total_tokens ?? (prompt + completion);
    const reasoning = readReasoningTokens(raw);
    if (reasoning !== null) {
        total.reasoningTokens = (total.reasoningTokens ?? 0) + reasoning;
    }
    const cached = readCachedTokens(raw);
    if (cached !== null) {
        total.cachedTokens = (total.cachedTokens ?? 0) + cached;
    }
    if (typeof raw.cost === 'number') {
        total.cost = (total.cost ?? 0) + raw.cost;
    }
}

function snapshotUsage(total) {
    const usage = {
        promptTokens: total.promptTokens,
        completionTokens: total.completionTokens,
        totalTokens: total.totalTokens
    };
    if (typeof total.reasoningTokens === 'number') {
        usage.reasoningTokens = total.reasoningTokens;
    }
    if (typeof total.cachedTokens === 'number') {
        usage.cachedTokens = total.cachedTokens;
    }
    if (typeof total.cost === 'number') {
        usage.cost = total.cost;
    }
    return usage;
}

export class Agent {
    _transport;
    _systemPrompt;
    _maxSteps;
    _requestTimeoutMs;
    _reasoning;
    _extraBody;
    _onStep;
    _workspace;
    _tools = new Map();
    _runInFlight = false;

    constructor(options = {}) {
        const {
            transport,
            systemPrompt,
            tools,
            workspace,
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
        if (workspace !== undefined && workspace !== false && (typeof workspace !== 'string' || workspace.trim().length === 0)) {
            throw new TypeError('workspace must be a directory path string, or false to disable session workspaces entirely');
        }

        this._transport = {
            apiKey: transport.apiKey,
            model: transport.model,
            baseUrl: (transport.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
            headers: transport.headers ?? {}
        };
        this._systemPrompt = systemPrompt;
        this._maxSteps = maxSteps;
        this._requestTimeoutMs = requestTimeoutMs;
        this._reasoning = reasoning;
        this._extraBody = extraBody ?? {};
        this._onStep = onStep;

        // workspace: false turns the session workspace off entirely: no
        // directory is ever created, no agent.workspace helpers, and the
        // built-in file tools are not registered (registerTool also rejects
        // host tools that declare requiresWorkspace: true). Otherwise every
        // agent gets a session workspace: a fresh session-* folder per run()
        // under the base directory (the `workspace` option, or
        // tmpdir()/rigline), materialized lazily on first use — see run().
        // Tools from `tools` are registered after the built-ins, so a
        // same-name tool overrides the built-in.
        this._workspace = workspace === false ? null : new Workspace(typeof workspace === 'string' ? workspace : undefined);
        if (this._workspace !== null) {
            for (const tool of [readTool(), writeTool(), editTool(), patchTool(), globTool(), grepTool()]) {
                this.registerTool(tool);
            }
        }

        for (const tool of tools ?? []) {
            this.registerTool(tool);
        }
    }

    // Host-side helpers (put/get/getBytes/list/exists/dir) for the current
    // session workspace; every agent with a workspace has one.
    get workspace() {
        if (this._workspace === null) {
            throw new Error('This agent has no workspace (workspace: false): pass a base directory path — or omit the option — to get session workspaces back');
        }
        return this._workspace.api;
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
        if (tool.requiresWorkspace !== undefined && typeof tool.requiresWorkspace !== 'boolean') {
            throw new TypeError(`tool.requiresWorkspace must be a boolean, for tool '${tool.name}'`);
        }
        // Fail fast at registration instead of mid-run: a tool that declares
        // it needs the session workspace cannot work on a workspace-less agent.
        if (tool.requiresWorkspace === true && this._workspace === null) {
            throw new TypeError(`tool '${tool.name}' requires a session workspace, but this agent was built with workspace: false`);
        }
        // Same-name registration replaces the existing tool — the built-in file
        // tools included, when a host wants its own behavior under that name.
        this._tools.set(tool.name, {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            execute: tool.execute
        });
    }

    // input: prompt string (systemPrompt is prepended) OR a messages array,
    // used verbatim — this is how a conversation continues via result.messages.
    // Each run() is one session: a session-* folder under the workspace base,
    // handed to every tool execution as execute(args, { workspaceDir }) so the
    // built-in file tools (and any host tool that touches the filesystem) are
    // confined to it. The folder is created lazily — workspaceDir is a getter,
    // so it only materializes when a tool actually reads it (a file tool about
    // to do IO) — and is removed just before the run settles. With
    // workspace: false there is no session at all and workspaceDir is null.
    async run(input) {
        if (this._runInFlight) {
            throw new Error('This agent already has a run() in flight; one run() at a time per Agent');
        }
        const messages = this._buildMessages(input);
        this._runInFlight = true;
        let session;
        try {
            session = this._workspace?.startSession();
            const toolContext = session === undefined
                ? { workspaceDir: null }
                : { get workspaceDir() { return session.dir; } };
            let steps = 0;
            const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: undefined };

            for (;;) {
                if (steps >= this._maxSteps) {
                    throw new MaxStepsError(this._maxSteps, messages);
                }

                const data = await this._request(messages);
                accumulateUsage(totalUsage, data.usage);
                steps += 1;

                const choice = data.choices?.[0];
                const message = choice?.message;
                if (!message || typeof message !== 'object') {
                    const err = new Error(`Unexpected provider response (missing choices[0].message): ${JSON.stringify(data).slice(0, 500)}`);
                    err.name = 'UnexpectedResponseError';
                    throw err;
                }
                messages.push(message);

                // Per-round-trip response metadata, verbatim when the provider
                // reports it (null otherwise): finishReason lets hosts react to
                // content_filter etc., id and model carry logging/billing
                // attribution. Surfaced on every onStep event and — from the
                // final round-trip — on the run() result.
                const responseMeta = {
                    id: typeof data.id === 'string' ? data.id : null,
                    model: typeof data.model === 'string' ? data.model : null,
                    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
                    nativeFinishReason: typeof choice.native_finish_reason === 'string' ? choice.native_finish_reason : null,
                };

                const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                if (toolCalls.length === 0) {
                    const usage = snapshotUsage(totalUsage);
                    const result = {
                        text: typeof message.content === 'string' ? message.content : '',
                        messages,
                        steps,
                        usage,
                        ...responseMeta
                    };
                    this._onStep?.({ step: steps, message, toolResults: [], usage, ...responseMeta });
                    return result;
                }

                const toolResults = [];
                for (const call of toolCalls) {
                    const content = await this._executeToolCall(call, toolContext);
                    toolResults.push({ toolCallId: call?.id, name: call?.function?.name, content });
                    messages.push({ role: 'tool', tool_call_id: call?.id, content });
                }
                this._onStep?.({ step: steps, message, toolResults, usage: snapshotUsage(totalUsage), ...responseMeta });
            }
        } finally {
            this._runInFlight = false;
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

    _buildMessages(input) {
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
        if (this._systemPrompt) {
            messages.push({ role: 'system', content: this._systemPrompt });
        }
        messages.push({ role: 'user', content: input });
        return messages;
    }

    // A throwing execute (or unknown tool, or malformed arguments) never aborts
    // the run: the message goes back to the model as `Error: <message>`.
    async _executeToolCall(call, context) {
        const name = call?.function?.name;
        try {
            const tool = this._tools.get(name);
            if (!tool) {
                throw new Error(`Unknown tool '${name}'`);
            }
            let args;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch {
                throw new Error(`Invalid JSON arguments for tool '${name}': ${call.function.arguments}`);
            }
            const output = await tool.execute(args, context);
            return formatToolOutput(output);
        } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    async _request(messages) {
        const url = `${this._transport.baseUrl}/chat/completions`;
        const body = { model: this._transport.model, messages, stream: false };
        if (this._tools.size > 0) {
            body.tools = [...this._tools.values()].map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                }
            }));
        }
        if (this._reasoning !== undefined) {
            body.reasoning = this._reasoning;
        }
        // extraBody is merged last and can override anything above it.
        Object.assign(body, this._extraBody);

        // One AbortController per logical request; the timeout spans all retry attempts.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._requestTimeoutMs);
        let response;
        try {
            response = await fetchWithRetry(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this._transport.apiKey}`,
                    ...this._transport.headers
                },
                body: JSON.stringify(body),
                signal: controller.signal
            }, { maxAttempts: RETRY_MAX_ATTEMPTS });
        } catch (err) {
            if (err?.name === 'AbortError') {
                throw new Error(`Provider request timed out after ${this._requestTimeoutMs}ms (POST ${url})`, { cause: err });
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
