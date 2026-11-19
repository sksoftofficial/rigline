import path from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';
import { resolveInsideRoot, assertRealInsideRoot } from '../lib/paths.js';

// Conventions inherited from opencode's read tool: one tool for files and
// directories, 1-based line numbers (`N: content`), offset/limit paging,
// directories-first listings, and continuation markers that teach the model
// how to keep reading.
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 2000;
const CHUNK_BYTES = 64 * 1024;
const LINE_TRUNCATION_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const CONTINUATION_MARKER = (next) => `[Output truncated. Continue reading with offset: ${next}]`;

function clampLine(text) {
    if (text.length <= MAX_LINE_LENGTH) {
        return text;
    }
    return text.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATION_SUFFIX;
}

// First pass: total line count and binary sniff. Never decodes, so a huge file
// costs IO but not memory.
async function scanFile(handle) {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    let newlines = 0;
    let lastByte = -1;
    let size = 0;
    let binary = false;
    for (;;) {
        const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, position);
        if (bytesRead === 0) {
            break;
        }
        if (position === 0 && buf.subarray(0, bytesRead).includes(0)) {
            binary = true;
        }
        const view = buf.subarray(0, bytesRead);
        let found = view.indexOf(10);
        while (found !== -1) {
            newlines += 1;
            found = view.indexOf(10, found + 1);
        }
        lastByte = view[bytesRead - 1];
        size += bytesRead;
        position += bytesRead;
    }
    return { binary, total: size === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1) };
}

// Second pass: collect the lines in [start, start + limit), bounded by
// MAX_BYTES overall and MAX_LINE_LENGTH per line. Trailing \r is stripped so
// the model sees the same LF view opencode's edit tool matches against.
async function collectLines(handle, start, limit) {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new TextDecoder();
    let position = 0;
    let lineNo = 0;
    let carry = '';
    let bytes = 0;
    let done = false;
    let next;
    const lines = [];
    for (;;) {
        if (done) {
            break;
        }
        const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, position);
        const text = bytesRead === 0 ? decoder.decode() : decoder.decode(buf.subarray(0, bytesRead), { stream: true });
        const parts = (carry + text).split('\n');
        carry = parts.pop();
        for (const raw of parts) {
            lineNo += 1;
            if (lineNo < start) {
                continue;
            }
            if (lines.length >= limit || bytes >= MAX_BYTES) {
                next = lineNo;
                done = true;
                break;
            }
            const clean = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            const line = clampLine(clean);
            lines.push({ number: lineNo, text: line });
            bytes += Buffer.byteLength(line);
        }
        if (bytesRead === 0) {
            break;
        }
        position += bytesRead;
    }
    if (!done && carry !== '') {
        lineNo += 1;
        if (lineNo >= start && lines.length < limit && bytes < MAX_BYTES) {
            const clean = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
            const line = clampLine(clean);
            lines.push({ number: lineNo, text: line });
        } else if (lineNo >= start) {
            next = lineNo;
        }
    }
    return { lines, next };
}

// Bounded Levenshtein: true when a and b are within `max` edits, so typos
// like note.txt -> notes.txt still get a did-you-mean suggestion.
function withinEdits(a, b, max) {
    if (Math.abs(a.length - b.length) > max) {
        return false;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        let best = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
            best = Math.min(best, current[j]);
        }
        if (best > max) {
            return false;
        }
        previous = current;
    }
    return previous[b.length] <= max;
}

// Teaching error for a missing path: point at the nearest folder that DOES
// exist and suggest up to three close matches among its entries.
async function notFoundMessage(root, relativePath, target) {
    const lines = [`File not found: ${relativePath}`];
    const parent = path.dirname(target);
    let nearest = parent;
    while (nearest !== root && !(await stat(nearest).then(() => true, () => false))) {
        nearest = path.dirname(nearest);
    }
    if (nearest !== parent) {
        const missing = path.relative(nearest, parent);
        const exists = path.relative(root, nearest) || '.';
        lines.push(`The folder ${missing} does not exist. The nearest folder that does is ${exists}.`);
    } else {
        const entries = await readdir(nearest, { withFileTypes: true }).catch(() => []);
        const needle = path.basename(relativePath).toLowerCase();
        const suggestions = entries
            .map((entry) => entry.name)
            .filter((name) => {
                const lower = name.toLowerCase();
                return lower === needle
                    || lower.startsWith(needle)
                    || needle.startsWith(lower)
                    || lower.includes(needle)
                    || withinEdits(lower, needle, 2);
            })
            .slice(0, 3);
        if (suggestions.length > 0) {
            lines.push(`Did you mean one of these?\n${suggestions.join('\n')}`);
        }
    }
    return lines.join('\n\n');
}

function renderFilePage(relativePath, offset, start, total, lines, next) {
    const content = [];
    if (lines.length === 0) {
        let header = `Read file ${relativePath}, 0 lines`;
        if (offset !== undefined && start > total) {
            header += ` (offset ${offset} is past the end; the file has ${total} ${total === 1 ? 'line' : 'lines'})`;
        }
        content.push(header);
    } else {
        content.push(`Read file ${relativePath}, lines ${start}-${start + lines.length - 1}`);
    }
    for (const line of lines) {
        content.push(`${line.number}: ${line.text}`);
    }
    if (next !== undefined) {
        content.push(CONTINUATION_MARKER(next));
    }
    return content.join('\n');
}

function renderDirectoryPage(relativePath, offset, selected, next) {
    const content = [];
    if (selected.length === 0) {
        content.push(`Read directory ${relativePath}, 0 entries`);
    } else {
        content.push(`Read directory ${relativePath}, entries ${offset}-${offset + selected.length - 1}`);
    }
    content.push(...selected);
    if (next !== undefined) {
        content.push(CONTINUATION_MARKER(next));
    }
    return content.join('\n');
}

// The directory view shared with the workspace helpers: files and dirs only,
// directories first with a trailing slash, plain localeCompare.
export async function listDirectory(target) {
    const entries = await readdir(target, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .map((entry) => ({ name: entry.name + (entry.isDirectory() ? '/' : ''), directory: entry.isDirectory() }))
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
        .map((entry) => entry.name);
}

export function readTool({ root } = {}) {
    if (typeof root !== 'string' || root.trim().length === 0) {
        throw new TypeError('readTool requires a root option: the base directory all reads are confined to');
    }
    const rootDir = path.resolve(root);

    return {
        name: 'read',
        description: [
            'Read the contents of a file or directory.',
            'Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content.',
            'Directory entries are returned one per line, directories first, with a trailing slash.',
            'Use offset and limit to read large files or directories in sections. A negative offset counts back from the end of a file. Prefer one larger read over many small slices.'
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File or directory to read, relative to the working root directory.' },
                offset: { type: 'integer', description: 'The line or directory entry to start reading from (1-based). Negative values count back from the end of a file.' },
                limit: { type: 'integer', description: `The maximum number of lines or directory entries to read (defaults to and capped at ${MAX_LINES}).` }
            },
            required: ['path'],
            additionalProperties: false
        },
        execute: async (args) => {
            const relativePath = args?.path;
            if (args?.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
                throw new Error('Limit must be a positive integer');
            }
            if (args?.offset !== undefined && (!Number.isInteger(args.offset) || args.offset === 0)) {
                throw new Error('Offset must be a non-zero integer (1-based, or negative to count back from the end of a file)');
            }
            const target = resolveInsideRoot(rootDir, relativePath);
            await assertRealInsideRoot(rootDir, relativePath, target);
            const targetStat = await stat(target).catch(() => null);
            if (targetStat === null) {
                throw new Error(await notFoundMessage(rootDir, relativePath, target));
            }
            const limit = Math.min(args?.limit ?? MAX_LINES, MAX_LINES);
            const offset = args?.offset;

            if (targetStat.isDirectory()) {
                if (offset !== undefined && offset < 0) {
                    throw new Error(`A negative offset only works for files, and ${relativePath} is a directory`);
                }
                const start = offset ?? 1;
                const visible = await listDirectory(target);
                const selected = visible.slice(start - 1, start - 1 + limit);
                const next = start + selected.length < visible.length ? start + selected.length : undefined;
                return renderDirectoryPage(relativePath, start, selected, next);
            }

            if (!targetStat.isFile()) {
                throw new Error(`Path is not a file or directory: ${relativePath}`);
            }

            const handle = await open(target, 'r');
            try {
                const { binary, total } = await scanFile(handle);
                if (binary) {
                    throw new Error(`Cannot read binary file: ${relativePath}`);
                }
                let start = offset ?? 1;
                if (start < 0) {
                    start = Math.max(1, total + start + 1);
                }
                const { lines, next } = await collectLines(handle, start, limit);
                return renderFilePage(relativePath, offset, start, total, lines, next);
            } finally {
                await handle.close();
            }
        }
    };
}
