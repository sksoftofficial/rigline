import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolveInsideRoot, assertRealInsideRoot } from '../lib/paths.js';
import { unifiedDiff } from '../lib/diff.js';

// Ported from opencode's patch tool (Vercel apply-patch format): one atomic
// multi-file operation — add, update (with optional move), delete. The whole
// patch is verified against the files (chaining earlier hunks in the same
// patch) before anything is written, so a failure applies nothing.

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARKER = '*** End of File';

// Parse the envelope into hunks. Update hunks keep raw chunk lines
// (context/+/-' ' prefixed); their meaning is resolved in deriveUpdate.
function parsePatch(patchText) {
    if (typeof patchText !== 'string' || patchText.length === 0) {
        throw new Error('patchText is required');
    }
    const lines = patchText.split('\n');
    if (lines[0] !== BEGIN) {
        throw new Error(`Invalid patch: must start with '${BEGIN}'`);
    }
    const hunks = [];
    let i = 1;
    while (i < lines.length) {
        const line = lines[i];
        if (line === END || line === '') {
            break;
        }
        if (line.startsWith(ADD)) {
            const filePath = line.slice(ADD.length);
            i += 1;
            const contents = [];
            while (i < lines.length && lines[i].startsWith('+')) {
                contents.push(lines[i].slice(1));
                i += 1;
            }
            if (contents.length === 0) {
                throw new Error(`Invalid patch: Add File ${filePath} has no '+' content lines`);
            }
            hunks.push({ type: 'add', path: filePath, contents: contents.join('\n') });
        } else if (line.startsWith(DELETE)) {
            hunks.push({ type: 'delete', path: line.slice(DELETE.length) });
            i += 1;
        } else if (line.startsWith(UPDATE)) {
            const filePath = line.slice(UPDATE.length);
            i += 1;
            let movePath;
            if (lines[i]?.startsWith(MOVE)) {
                movePath = lines[i].slice(MOVE.length);
                i += 1;
            }
            const chunks = [];
            let current = { before: undefined, lines: [] };
            let eof = false;
            while (i < lines.length && !lines[i].startsWith('*** ')) {
                const body = lines[i];
                if (body.startsWith('@@')) {
                    if (current.lines.length > 0 || current.before !== undefined) {
                        chunks.push(current);
                    }
                    current = { before: body === '@@' ? '' : body.slice(3), lines: [] };
                } else if (body.startsWith('+') || body.startsWith('-') || body.startsWith(' ')) {
                    current.lines.push(body);
                } else if (body === '') {
                    // tolerate a blank line between chunk bodies and the next header
                    break;
                } else {
                    throw new Error(`Invalid patch: line ${i + 1} of Update File ${filePath} must start with '+', '-', ' ' or '@@': ${JSON.stringify(body)}`);
                }
                i += 1;
            }
            if (current.lines.length > 0 || current.before !== undefined) {
                chunks.push(current);
            }
            // '*** End of File' inside an update truncates the file there.
            if (lines[i] === EOF_MARKER) {
                eof = true;
                i += 1;
            }
            hunks.push({ type: 'update', path: filePath, movePath, chunks, eof });
        } else {
            throw new Error(`Invalid patch: unexpected line ${i + 1}: ${JSON.stringify(line)}`);
        }
    }
    if (hunks.length === 0) {
        throw new Error('Invalid patch: empty patch');
    }
    return hunks;
}

function findNextLineIndex(lines, needle, from) {
    for (let i = from; i < lines.length; i += 1) {
        if (needle === '' || lines[i].includes(needle)) {
            return i;
        }
    }
    return -1;
}

// Apply update chunks to the original content. A '@@ context' marker (or the
// first '-'/' ' line when there is none) repositions at the next line
// containing it; then '+' adds, '-' removes (must match exactly), ' '
// verifies and keeps. eof hunks drop everything after the last chunk.
function deriveUpdate(relativePath, hunk, original) {
    const lines = original.split('\n');
    const out = [];
    let search = 0;
    let positioned = false;
    for (const chunk of hunk.chunks) {
        if (chunk.before !== undefined) {
            const index = findNextLineIndex(lines, chunk.before, search);
            if (index === -1) {
                throw new Error(`patch verification failed: could not find context ${JSON.stringify(chunk.before)} in ${relativePath}`);
            }
            // The context marker is a pointer: keep the line it names and
            // apply the chunk's body lines after it.
            out.push(...lines.slice(search, index + 1));
            search = index + 1;
            positioned = true;
        } else if (!positioned && chunk.lines.length > 0 && !chunk.lines[0].startsWith('+')) {
            const index = findNextLineIndex(lines, chunk.lines[0].slice(1), search);
            if (index === -1) {
                throw new Error(`patch verification failed: could not find line ${JSON.stringify(chunk.lines[0].slice(1))} in ${relativePath}`);
            }
            out.push(...lines.slice(search, index));
            search = index;
        }
        for (const body of chunk.lines) {
            if (body.startsWith('+')) {
                out.push(body.slice(1));
                continue;
            }
            const expected = body.slice(1);
            if (lines[search] !== expected) {
                throw new Error(`patch verification failed: line mismatch in ${relativePath}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(lines[search] ?? '<end of file>')}`);
            }
            if (!body.startsWith('-')) {
                out.push(expected);
            }
            search += 1;
        }
    }
    if (!hunk.eof) {
        out.push(...lines.slice(search));
    }
    return out.join('\n');
}

export function patchTool({ root } = {}) {
    if (typeof root !== 'string' || root.trim().length === 0) {
        throw new TypeError('patchTool requires a root option: the base directory all writes are confined to');
    }
    const rootDir = path.resolve(root);

    return {
        name: 'patch',
        description: 'Use the patch tool to edit multiple files in one atomic operation. The patch language is a stripped-down, file-oriented diff format. Wrap everything in \'*** Begin Patch\' / \'*** End Patch\'. Each file section starts with one of three headers: \'*** Add File: <path>\' (create; every following line is a \'+\' line with the initial contents), \'*** Delete File: <path>\' (remove; nothing follows), or \'*** Update File: <path>\' (patch in place, optionally followed by \'*** Move to: <new path>\'). Update bodies are chunks: a \'@@ <context>\' line repositions at the next file line containing that context, then \'-\' removes the line (must match exactly), \'+\' adds a line, and a \' \' prefix verifies and keeps a line. \'*** End of File\' inside an update truncates the file at that point. The whole patch is verified against the files before anything is written — one bad line applies nothing. For single small edits prefer the edit tool.',
        parameters: {
            type: 'object',
            properties: {
                patchText: { type: 'string', description: 'The full patch text describing add, update, and delete operations.' }
            },
            required: ['patchText'],
            additionalProperties: false
        },
        execute: async (args) => {
            const hunks = parsePatch(args?.patchText);

            // Resolve and confine every path first.
            for (const hunk of hunks) {
                hunk.target = resolveInsideRoot(rootDir, hunk.path);
                await assertRealInsideRoot(rootDir, hunk.path, hunk.target);
                if (hunk.movePath !== undefined) {
                    hunk.moveTarget = resolveInsideRoot(rootDir, hunk.movePath);
                    await assertRealInsideRoot(rootDir, hunk.movePath, hunk.moveTarget);
                }
            }

            // Verify every hunk against disk — or against the content an
            // earlier hunk in this same patch produced — before writing.
            const pending = new Map();
            const prepared = [];
            for (const hunk of hunks) {
                const previous = pending.get(hunk.target);
                if (hunk.type === 'add') {
                    const alreadyGone = previous === null;
                    const existsOnDisk = alreadyGone ? false : await stat(hunk.target).then(() => true, () => false);
                    if ((previous !== undefined && previous !== null) || existsOnDisk) {
                        throw new Error(`patch verification failed: cannot add ${hunk.path}: file already exists`);
                    }
                    const content = hunk.contents.endsWith('\n') || hunk.contents === '' ? hunk.contents : `${hunk.contents}\n`;
                    pending.set(hunk.target, content);
                    prepared.push({ hunk, before: '', after: content });
                } else if (hunk.type === 'delete') {
                    const before = previous !== undefined && previous !== null
                        ? previous
                        : previous === null ? null : await readFile(hunk.target, 'utf8').catch(() => null);
                    if (before === null) {
                        throw new Error(`patch verification failed: cannot delete ${hunk.path}: file does not exist`);
                    }
                    pending.set(hunk.target, null);
                    prepared.push({ hunk, before, after: '' });
                } else {
                    const original = previous !== undefined && previous !== null
                        ? previous
                        : await (async () => {
                            if (previous === null) {
                                return null;
                            }
                            return readFile(hunk.target, 'utf8').catch(() => null);
                        })();
                    if (original === null) {
                        throw new Error(`patch verification failed: cannot update ${hunk.path}: file does not exist`);
                    }
                    const after = deriveUpdate(hunk.path, hunk, original);
                    const destination = hunk.moveTarget ?? hunk.target;
                    if (hunk.moveTarget) {
                        pending.set(hunk.target, null);
                    }
                    pending.set(destination, after);
                    prepared.push({ hunk, before: original, after });
                }
            }

            // All verified — apply.
            const summary = [];
            const diffs = [];
            for (const { hunk, before, after } of prepared) {
                if (hunk.type === 'delete') {
                    await rm(hunk.target);
                    summary.push(`Deleted ${hunk.path}`);
                } else {
                    const destination = hunk.moveTarget ?? hunk.target;
                    await mkdir(path.dirname(destination), { recursive: true });
                    await writeFile(destination, after, 'utf8');
                    if (hunk.moveTarget) {
                        await rm(hunk.target, { force: true });
                        summary.push(`Moved ${hunk.path} -> ${hunk.movePath} (${hunk.type === 'add' ? 'added' : 'updated'})`);
                    } else {
                        summary.push(hunk.type === 'add' ? `Added ${hunk.path}` : `Updated ${hunk.path}`);
                    }
                    const diff = unifiedDiff(before, after);
                    if (diff) {
                        diffs.push(diff);
                    }
                }
            }
            return `Applied patch (${summary.length} operation${summary.length === 1 ? '' : 's'}):\n${summary.map((line) => `- ${line}`).join('\n')}${diffs.length > 0 ? `\n\n${diffs.join('\n')}` : ''}`;
        }
    };
}
