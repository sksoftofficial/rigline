# rigline

Embeddable Node.js agent harness: an LLM loop with caller-registered tools, imported and run
in-process by your worker code. A **library** — no CLI, no server, no config files, no env reads.

- Zero runtime dependencies (global `fetch` + `node:` builtins), ESM only, Node.js >= 20.
- OpenAI-compatible transport, OpenRouter by default; any compatible host via `baseUrl`.
- You own the domain: built-ins are the file toolkit (`read` / `write` / `edit` / `patch` / `glob` / `grep`)
  plus `webfetch` / `websearch`, conventions inherited from [opencode](https://github.com/sst/opencode);
  everything else is registered by the host.

## Install

```bash
npm install @sksoftofficial/rigline
```

or from a local checkout while developing:

```bash
npm install /absolute/path/to/rigline
```

## Minimal run

```js
import { Agent } from 'rigline';
import { readTool, writeTool } from 'rigline/tools';

const workDir = '/data/editorial/job-42';

const agent = new Agent({
    transport: {
        apiKey: process.env.OPENROUTER_API_KEY,   // rigline never reads env itself — you pass it in
        model: 'anthropic/claude-sonnet-4.5',      // provider-prefixed OpenRouter slug
    },
    systemPrompt: 'You are a careful editorial assistant.',
    tools: [readTool({ root: workDir }), writeTool({ root: workDir })],
    maxSteps: 24,
    requestTimeoutMs: 120000,
    onStep: (step) => console.log('step', step.step, step.toolResults.map((r) => r.name)),
});

const result = await agent.run('Read notes.txt in the work dir and draft a headline into draft.md');
// result: { text, messages, steps, usage: { promptTokens, completionTokens, cost? } }
```

## Custom tools

```js
agent.registerTool({
    name: 'do_thing',
    description: 'Does the thing.',
    parameters: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
    },
    execute: async ({ x }) => `did thing with ${x}`,   // throw = recoverable tool error
});
```

A throwing `execute` never aborts the run: the message goes back to the model as
`Error: <message>` in that call's tool result and the loop continues — the model can retry or adjust.
String returns pass through verbatim; other values are JSON-serialized.

## Continuing a conversation

`result.messages` is the full transcript. Feed it back (plus new turns) — arrays are used
**verbatim**, so `systemPrompt` is not re-prepended:

```js
const result = await agent.run('First task');
const next = await agent.run([...result.messages, { role: 'user', content: 'Now do X' }]);
```

## API

### `new Agent(options)`

| option | type | default | notes |
| --- | --- | --- | --- |
| `transport` | object | — | required: `{ apiKey, model, baseUrl?, headers? }` |
| `transport.apiKey` | string | — | sent as `Authorization: Bearer <key>` |
| `transport.model` | string | — | provider-prefixed OpenRouter slug, e.g. `anthropic/claude-sonnet-4.5` |
| `transport.baseUrl` | string | `https://openrouter.ai/api/v1` | any OpenAI-compatible host; trailing `/` tolerated |
| `transport.headers` | object | `{}` | extra headers, merged after the standard ones (can override) |
| `systemPrompt` | string | — | prepended as `role: 'system'` for string prompts |
| `tools` | array | `[]` | tool objects, same shape as `registerTool` |
| `sandboxed` | `true` \| string | — | `true` → per-run session folders under `tmpdir()/rigline` (Linux: `/tmp/rigline`); a path string → that directory as the base. Auto-registers all six built-in tools scoped to the session folder and exposes `agent.workspace`. See [Sandbox & workspace](#sandbox--workspace) |
| `maxSteps` | number | `24` | max model round-trips per `run()` |
| `requestTimeoutMs` | number | `120000` | covers the whole request incl. retries; aborts on expiry |
| `reasoning` | object | — | sent verbatim as the request's `reasoning` param, e.g. `{ enabled: true, max_tokens: 128 }`; see below |
| `extraBody` | object | `{}` | shallow-merged into every request body **last** (can override anything, incl. `reasoning`) — for `temperature`, `top_p`, `max_tokens`, `provider` routing, … |
| `onStep` | function | — | observability hook, see below |

### `agent.registerTool(tool)`

| field | notes |
| --- | --- |
| `name` | must match `/^[a-zA-Z0-9_-]{1,64}$/`; duplicate registration throws |
| `description` | what the model sees |
| `parameters` | JSON Schema object (`{ type: 'object', properties, required }`) |
| `execute` | `async (args) => result`; throw = recoverable tool error |

### `agent.run(input)` → `Promise<{ text, messages, steps, usage }>`

- `input`: prompt **string** (systemPrompt prepended) or a **messages array** (used verbatim —
  this is how conversations continue via `result.messages`).
- Executes every `tool_call` in a turn (sequentially, in order), appends each `role: 'tool'`
  result with its matching `tool_call_id`, and loops.
- Stops at the first tool-free assistant reply (its text becomes `result.text`), or throws
  `MaxStepsError` (`.messages` = full transcript) when `maxSteps` is exceeded.
- `usage`: `{ promptTokens, completionTokens }` summed over the run, plus `cost` (USD) summed
  when OpenRouter returns `usage.cost`.

### `agent.runJson(input)` → parsed JSON

Same as `run()`, then `JSON.parse`s the final text and returns the parsed value.
On parse failure throws `JsonParseError` with `.raw` (the model's text) and `.result` (the full
run result). Parsing is **strict** — markdown code fences are not stripped; instruct the model
accordingly.

### `onStep(event)` — fires once per model round-trip

```js
{ step: 3, message: <assistant message>, toolResults: [{ toolCallId, name, content }], usage: {...} }
```

`toolResults` is `[]` on the final (tool-free) step. `content` for failed calls starts with `Error: `.

## Built-in tools — `rigline/tools`

```js
import { readTool, writeTool, editTool, patchTool, globTool, grepTool, webfetchTool, websearchTool } from 'rigline/tools';

readTool({ root: workDir });    // read({ path, offset?, limit? }) -> files AND directories
writeTool({ root: workDir });   // write({ path, content }) -> create/overwrite, makes parent dirs
editTool({ root: workDir });    // edit({ path, oldString, newString, replaceAll? }) -> exact replace
patchTool({ root: workDir });   // patch({ patchText }) -> atomic multi-file add/update/move/delete
globTool({ root: workDir });    // glob({ pattern, path?, hidden?, limit? }) -> matching file paths
grepTool({ root: workDir });    // grep({ pattern, path?, include?, literal?, caseSensitive?, limit? })
webfetchTool();                 // webfetch({ url, format?, timeout? }) -> fetch a URL as markdown
websearchTool({ apiKey });      // websearch({ query }) -> Brave Search results as markdown
```

Conventions inherited from [opencode](https://github.com/sst/opencode)'s toolset.

### `read` — one tool, files and directories

```text
Read file notes.txt, lines 1-2
1: first line
2: second line

Read directory ., entries 1-2
subdir/
notes.txt
```

- Text lines are prefixed `N: ` (1-based); the prefix is reference, not content. CRLF is
  shown as LF; binary files are refused.
- Directory entries are one per line, directories first with a trailing `/`.
- `offset` (1-based; negative counts back from the end of a file) and `limit`
  (default and cap 2000) page through large files/listings. Output is bounded
  (2000 chars/line, 50KB total) with a `[Output truncated. Continue reading with offset: N]` marker.
- Misses teach: `File not found: note.txt` + `Did you mean one of these? notes.txt`, or the
  nearest folder that does exist.

### `write`

Creates or overwrites a file (parent directories created automatically) and answers
`Created file successfully: draft.md` / `Wrote file successfully: draft.md` so the model
knows which happened. For partial changes, the model is told to use `edit` instead.

### `edit`

Exact find-and-replace built against read's `N: ` LF view — the model never needs to
rewrite a whole file for a small change.

- Three-tier matching ladder: exact → typographic variants (smart quotes, dashes,
  Unicode spaces) → per-line trailing-whitespace tolerance. CRLF files match with `\n`
  strings and keep their endings (per-line, even in mixed files).
- Unique-by-default: multiple matches fail with `Found N matches…` unless `replaceAll`
  is set. `oldString === newString` and empty `oldString` are rejected.
- Misses teach instead of just failing: `newString is already in the file` (edit likely
  already applied), or the closest lines numbered like read output — without rereading.
- Success returns `Edited <path> (N replacements)` plus a bounded unified diff preview.

### `patch`

One atomic multi-file operation in the Vercel `*** Begin Patch` format:

```text
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
```

- `@@ context` repositions at the next file line containing that text; `-`/`+`/` `
  lines then remove/add/verify lines after it. `*** End of File` truncates the file.
- **All-or-nothing**: every file section is verified against disk (chaining earlier
  sections of the same patch — add then update works) before anything is written; one
  bad line applies nothing.

### `glob` and `grep`

Pure-JavaScript search (no ripgrep binary, no deps):

- `glob` matches file paths (`**/*.ts`, `*.{json,md}`, `?`, `[abc]`; a pattern with no
  `/` matches basenames at any depth). Results one per line, `No files found` when empty.
- `grep` searches file contents, grouped by file as `  Line N: text`, with `include`
  glob filtering, `literal` mode, and case sensitivity. Binary files are skipped.
- Both bound output with `(Results are truncated: showing first N results. Consider
  using a more specific path or pattern.)`.
- Walk deviations from ripgrep: no `.gitignore` handling, `.git` always skipped, hidden
  entries skipped unless `glob`'s `hidden: true`, and symlinked directories are never
  followed (walks cannot escape `root`).

### `webfetch`

Fetches an HTTP(S) URL and returns it as markdown (default), text, or HTML —
a zero-dependency port of opencode's tool with its own HTML tokenizer and
markdown converter (no htmlparser2, no turndown):

- `format: 'markdown'` converts HTML pages (ATX headings, links, nested lists,
  fenced code with language detection and content-safe fence sizing,
  blockquotes, pipe tables with a plain-text fallback, images; hidden
  subtrees, `<head>`, scripts, styles and collapsed `<details>` suppressed).
  Non-HTML content (JSON, plain text, XML, ...) is returned verbatim for
  every format; `format: 'text'` strips markup to plain text; `format:
  'html'` returns the raw body.
- Redirects are followed manually (up to 10) and every hop must stay on
  http/https with no embedded credentials; fragments are stripped.
- Only textual content types are accepted — images and binaries fail with
  `unsupported fetched ... content type` instead of wasting a round-trip.
  Anything `+xml` (including SVG) counts as textual, as in opencode.
- Bodies are capped at 5 MB (`Response too large`), requests at 30 s by
  default / 120 s max (`timeout` in seconds). One timeout spans all hops.
- Cloudflare challenges (403 + `cf-mitigated: challenge`) are retried once
  with a plain client user agent; `webfetchTool({ userAgent })` overrides
  the default `Rigline-User` agent.

`webfetch` is network-scoped, not filesystem-scoped: it takes no `root`, and
`sandboxed` does **not** auto-register it — add it via `tools` if you want it
in a sandboxed agent. Errors read `Unable to fetch <url>: <reason>`
(`response status 404`, `request timed out after 30s`, ...). SSRF posture is
the host's call: wrap `execute` or don't register the tool for untrusted
models.

### `websearch`

Web search on the **Brave Search API** — opencode's websearch tool shape and
output format, with Brave as the only provider (no provider registry, no
keyless Tavily). Brave has no keyless mode, so the key is required and passed
at construction — the host reads its own env/config and injects it:

```js
import { websearchTool } from 'rigline/tools';

const agent = new Agent({
    transport: { apiKey, model },
    tools: [websearchTool({ apiKey: process.env.BRAVE_API_KEY })],
});
```

- Input is `{ query }` only; results render opencode-style: `## [title](url)`
  + `Published: <ISO>` (from Brave's `date`/`page_age`; the relative `age`
  string is skipped rather than mangled into a fake timestamp) + description,
  entries joined by blank lines. No hits → `No search results found. Please
  try a different query.`
- Factory options: `apiKey` (required), `count` (default 8, max 20),
  `country`, `searchLang`, `timeoutMs` (default 25 000, covers the whole
  request).
- Teaching errors kept from opencode: `Web search rate limited (HTTP 429)` —
  the free tier allows 1 query/sec, so bursts will see this — and
  `Web search authentication failed (HTTP 401)`; other statuses read
  `Web search request failed (HTTP <status>)`. Network/timeout failures read
  `Unable to search the web for "<query>": <detail>`.
- Descriptions are requested undecorated (`text_decorations=false`) so no
  `<strong>` highlight markup leaks into the markdown.
- Network-scoped like `webfetch`: no `root`, not auto-registered by
  `sandboxed` — opt in via `tools`.

### All built-in file tools

- **Require** `root`; there is no default (and never `/`).
- Paths are relative and confined to `root`: absolute paths and `..` escapes are rejected
  with a clear error, and paths are verified against real paths — a symlink inside `root`
  pointing outside is rejected too (best-effort; see the sandbox notes on TOCTOU).

## Sandbox & workspace

Pass `sandboxed` to give every run its own scratch folder the built-in tools cannot
escape — no `root` wiring, no cleanup bookkeeping on your side:

```js
const agent = new Agent({
    transport: { apiKey, model },
    sandboxed: true,              // base: tmpdir()/rigline — or pass '/path/to/base'
});

await agent.workspace.put('input.txt', data);   // stage into the session folder

const result = await agent.run('process input.txt');
// read/write/edit/patch/glob/grep are already registered, scoped to
// session-<id>/ for this run; the folder is removed just before run() returns.
```

Lifecycle — each `run()` call is one session:

- A fresh `session-*` folder is created under the base, lazily: when you stage files
  via `put()`, otherwise at run start.
- All six built-in **file** tools are auto-registered scoped to that folder (`webfetch`
  is network-scoped and not auto-registered — opt in via `tools`). Absolute paths,
  `..` escapes, and symlinks pointing outside are rejected. Passing your own tool with
  one of those names in `tools` throws (the sandbox already registers them).
- When the run settles — final answer, `MaxStepsError`, or any failure — the session
  folder is removed (best-effort) before control returns. The base directory stays.

`agent.workspace` (undefined without `sandboxed`) — host-side helpers with the same
confinement, so your app never does raw `fs` against the sandbox:

| helper | notes |
| --- | --- |
| `dir()` | absolute session folder path, or `null` before one exists |
| `put(relPath, content)` | string or Buffer; creates parent dirs; creates the session lazily |
| `get(relPath)` / `getBytes(relPath)` | utf8 string / Buffer |
| `list(relPath?)` | entries, directories first with trailing `/` |
| `exists(relPath)` | boolean |

Limits worth knowing:

- **Files do not outlive the run** — get results back via the final text. A `keep`
  option is a trivial future addition if post-run file retrieval is ever needed.
- Only the built-in tools are confined; custom tools you register are arbitrary host
  code and can go anywhere.
- A sandboxed agent runs **one `run()` at a time** — the session is per run.
- Symlink checks race nothing in practice but are verified once before each IO; a
  symlink swapped in between check and IO can still escape (TOCTOU, best-effort).

## Reasoning models

Enable provider thinking by passing the OpenRouter `reasoning` object; it is sent verbatim on
**every** turn of the loop. Whatever reasoning the model returns is round-tripped back to the
provider automatically (required e.g. for Anthropic extended thinking with tool use):

```js
const agent = new Agent({
    transport: { apiKey, model: 'z-ai/glm-5.3-flash' },
    reasoning: { enabled: true, max_tokens: 128 },   // pick budgets per use case
    // ...
});
```

Field notes (from production harness experience):

- Send `enabled` + `max_tokens` — **not** `effort` alongside `max_tokens`; some providers treat
  them as mutually exclusive and 400.
- Budgets are per-model and per-use-case; tune them yourself (e.g. 128 for cheap classification,
  1268–4096 for drafting). Some providers ignore the budget entirely.
- A hard budget can truncate thinking mid-thought rather than making the model reason less.
- Reasoning tokens are billed as completion tokens; they are included in `usage.completionTokens`.

## Errors

| error | meaning |
| --- | --- |
| `MaxStepsError` | `maxSteps` round-trips without a final answer; `.messages` has the transcript |
| `ApiError` | non-OK provider response after retries; `.status`, `.url`, `.body` |
| `JsonParseError` | `runJson` final text failed `JSON.parse`; `.raw`, `.result` |

## Transport & retry behavior

- `POST ${baseUrl}/chat/completions`, `stream: false`, OpenAI function-calling `tools`.
- Retry ladder: **429 and 5xx only**, up to **3 total attempts**, exponential backoff
  (500 ms base, ×2 per retry) with 50–150 % jitter, capped at 8 s.
  Network errors and timeouts are **not** retried; other 4xx fail immediately as `ApiError`.
- OpenRouter attribution (optional): `transport.headers: { 'HTTP-Referer': 'https://yourapp', 'X-Title': 'Your App' }`.

## Tests

```bash
npm test        # node --test test/ — transport is mocked: no network, no API key
```
