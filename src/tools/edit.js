import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolveInsideRoot, assertRealInsideRoot, sessionWorkspaceRoot } from '../lib/paths.js';
import { unifiedDiff } from '../lib/diff.js';

// Ported from opencode's edit tool. Three-tier matching ladder against the
// LF view the read tool shows (so CRLF never blocks a match and never leaks
// into untouched regions): exact → typographic variants (quotes, dashes,
// spaces) → per-line trailing-whitespace tolerance. Unique-by-default or
// replaceAll; misses teach via the closest lines, numbered like read output.

const CRLF = '\r\n';

function normalizeForMatch(value) {
    return value
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function findOccurrences(content, search) {
    const result = [];
    let offset = 0;
    while ((offset = content.indexOf(search, offset)) !== -1) {
        result.push({ start: offset, end: offset + search.length });
        offset += search.length;
    }
    return result;
}

// Line-wise tier: every line must match after trimEnd + typographic
// normalization. A search ending in \n only matches a region whose last line
// has a newline. Overlapping candidates collapse to the first.
function findLineOccurrences(content, search) {
    const trailingNewline = search.endsWith('\n');
    const expected = search.split('\n');
    if (trailingNewline) {
        expected.pop();
    }
    const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
        .filter((match) => match[0] !== '')
        .map((match) => {
            const newline = match[0].endsWith('\n');
            const text = newline ? match[0].slice(0, -1) : match[0];
            return {
                start: match.index,
                end: match.index + match[0].length,
                text,
                contentEnd: match.index + text.length - (text.endsWith('\r') ? 1 : 0),
                newline
            };
        });
    const candidates = [];
    for (let index = 0; index <= lines.length - expected.length; index += 1) {
        const actual = lines.slice(index, index + expected.length);
        const every = actual.every(
            (item, lineIndex) => normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd())
        );
        if (!every) {
            continue;
        }
        const last = actual[actual.length - 1];
        if (trailingNewline && !last.newline) {
            continue;
        }
        candidates.push({ start: lines[index].start, end: trailingNewline ? last.end : last.contentEnd });
    }
    return candidates.reduce((result, candidate) => {
        if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) {
            return result;
        }
        result.push(candidate);
        return result;
    }, []);
}

// The dominant line ending in text, or fallback when there is none.
function lineEnding(text, fallback) {
    const crlfCount = text.split(CRLF).length - 1;
    const lfCount = text.split('\n').length - 1 - crlfCount;
    if (crlfCount === lfCount) {
        return fallback;
    }
    return crlfCount > lfCount ? CRLF : '\n';
}

// For each line of `after`, the index of the `before` line it keeps (LCS,
// compared like the trailing-whitespace tier) or, between kept lines, the
// line it takes the place of; undefined for lines with no counterpart.
function alignLines(before, after) {
    const width = after.length + 1;
    const table = new Uint32Array((before.length + 1) * width);
    for (let i = before.length - 1; i >= 0; i -= 1) {
        for (let j = after.length - 1; j >= 0; j -= 1) {
            table[i * width + j] = before[i] === after[j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const result = new Array(after.length);
    const gapBefore = [];
    const gapAfter = [];
    const flush = () => {
        gapAfter.forEach((j, k) => {
            result[j] = gapBefore[k];
        });
        gapBefore.length = 0;
        gapAfter.length = 0;
    };
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
            flush();
            result[j] = i;
            j += 1;
            i += 1;
            continue;
        }
        if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            gapBefore.push(i);
            i += 1;
        } else {
            gapAfter.push(j);
            j += 1;
        }
    }
    while (i < before.length) {
        gapBefore.push(i);
        i += 1;
    }
    while (j < after.length) {
        gapAfter.push(j);
        j += 1;
    }
    flush();
    return result;
}

// Joins the replacement's lines with endings taken from the matched source
// region: a line that keeps a region line reuses that line's ending; a line
// that changes in place reuses the ending of the line it replaces. Unchanged
// context inside a match therefore keeps its bytes even in a mixed-ending file.
function withRegionEndings(region, replacement, fallback) {
    const before = region.split(/\r?\n/);
    const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0]);
    const after = replacement.split('\n');
    const key = (line) => normalizeForMatch(line.trimEnd());
    const source = alignLines(before.map(key), after.map(key));
    return after.map((line, index) => (index === after.length - 1 ? line : line + (endings[source[index]] ?? fallback))).join('');
}

// Number of sorted positions strictly before offset.
function countBefore(positions, offset) {
    let low = 0;
    let high = positions.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (positions[middle] < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

// Matches against the LF view read shows, then maps offsets back to the
// source, so CRLF and mixed line endings neither block matches nor leak into
// untouched regions.
function matchView(source, oldString, newString) {
    const view = source.replaceAll(CRLF, '\n');
    const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index);
    const fileEnding = lineEnding(source, '\n');
    const search = oldString.replaceAll(CRLF, '\n');
    const replacement = newString.replaceAll(CRLF, '\n');
    const exact = findOccurrences(view, search);
    // These one-to-one mappings preserve offsets into the LF view.
    const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
    const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search);
    const chosen = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing;
    return {
        matches: chosen.map((match) => ({
            start: match.start + countBefore(removed, match.start),
            end: match.end + countBefore(removed, match.end)
        })),
        replace: (match) => {
            const region = source.slice(match.start, match.end);
            return withRegionEndings(region, replacement, lineEnding(region, fileEnding));
        }
    };
}

const HINT_LINES = 12;
const HINT_LINE_LENGTH = 200;

// A short hint for an oldString miss, so the next attempt can succeed
// without rereading the file: newString is already there (often an edit that
// already applied), or the lines closest to oldString, numbered like read
// output. Lines vote for where oldString starts when they match ignoring all
// whitespace; at least half must agree. Only the span from the first to the
// last line that matched is shown, so padding oldString cannot reveal the
// lines after it.
function missHint(source, oldString, newString) {
    const view = source.replaceAll(CRLF, '\n');
    const replacement = newString.replaceAll(CRLF, '\n');
    if (replacement.trim().length >= 20 && normalizeForMatch(view).includes(normalizeForMatch(replacement))) {
        return 'newString is already in the file, so this edit may already be applied.';
    }
    const key = (line) => normalizeForMatch(line).replace(/\s+/g, ' ').trim();
    const distinct = (line) => /[\p{L}\p{N}]/u.test(line);
    const lines = view.split('\n');
    const search = oldString.replaceAll(CRLF, '\n').split('\n');
    const positions = new Map();
    lines.forEach((line, index) => {
        const value = key(line);
        if (!distinct(value)) {
            return;
        }
        const found = positions.get(value);
        if (found) {
            found.push(index);
        } else {
            positions.set(value, [index]);
        }
    });
    const votes = new Map();
    const wanted = search.filter((line, offset) => {
        const value = key(line);
        if (!distinct(value)) {
            return false;
        }
        for (const index of positions.get(value) ?? []) {
            votes.set(index - offset, (votes.get(index - offset) ?? 0) + 1);
        }
        return true;
    }).length;
    let start = 0;
    let best = 0;
    for (const [offset, count] of votes) {
        if (count > best) {
            best = count;
            start = offset;
        }
    }
    if (best === 0 || best * 2 < wanted) {
        return undefined;
    }
    const matched = [];
    for (let offset = 0; offset < search.length; offset += 1) {
        const value = key(search[offset]);
        const index = start + offset;
        if (value !== '' && index >= 0 && index < lines.length && key(lines[index]) === value) {
            matched.push(index);
        }
    }
    if (matched.length === 0) {
        return undefined;
    }
    const from = matched[0];
    const to = Math.min(matched[matched.length - 1] + 1, from + HINT_LINES);
    return [
        'The closest lines in the file:',
        ...lines.slice(from, to).map((line, index) => `${from + index + 1}: ${line.length > HINT_LINE_LENGTH ? `${line.slice(0, HINT_LINE_LENGTH)}…` : line}`)
    ].join('\n');
}

export function editTool() {
    return {
        name: 'edit',
        description: 'Edit the contents of a file by finding and replacing exact text. When editing text from the read tool\'s output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file\'s existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File to edit, relative to the session workspace.' },
                oldString: { type: 'string', description: 'Exact text to find and replace.' },
                newString: { type: 'string', description: 'Text to replace oldString with (must differ from oldString).' },
                replaceAll: { type: 'boolean', description: 'Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.' }
            },
            required: ['path', 'oldString', 'newString'],
            additionalProperties: false
        },
        execute: async (args, context) => {
            const rootDir = sessionWorkspaceRoot(context, 'edit');
            if (typeof args?.oldString !== 'string' || typeof args?.newString !== 'string') {
                throw new Error('oldString and newString must be strings');
            }
            if (args.oldString === args.newString) {
                throw new Error('No changes to apply: oldString and newString are identical.');
            }
            if (args.oldString === '') {
                throw new Error('oldString must not be empty. Use the write tool to create or overwrite a file.');
            }
            const relativePath = args.path;
            const target = resolveInsideRoot(rootDir, relativePath);
            await assertRealInsideRoot(rootDir, relativePath, target);
            const targetStat = await stat(target).catch(() => null);
            if (targetStat === null) {
                throw new Error(`File not found: ${relativePath}`);
            }
            if (!targetStat.isFile()) {
                throw new Error(`Path is not a file: ${relativePath}`);
            }
            const source = await readFile(target, 'utf8');

            // Strings that differ only in \r ask to change line endings
            // themselves, so they apply to the exact bytes. Every other edit
            // matches the LF view read shows the model and keeps the file's
            // endings.
            const endingsOnly = args.oldString.replaceAll('\r', '') === args.newString.replaceAll('\r', '');
            const { matches, replace } = endingsOnly
                ? { matches: findOccurrences(source, args.oldString), replace: () => args.newString }
                : matchView(source, args.oldString, args.newString);

            if (matches.length === 0) {
                const hint = missHint(source, args.oldString, args.newString);
                throw new Error(`Could not find oldString in ${relativePath}. It must match exactly, including whitespace and indentation.${hint ? `\n\n${hint}` : ''}`);
            }
            if (matches.length > 1 && args?.replaceAll !== true) {
                throw new Error(`Found ${matches.length} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`);
            }

            const replaced = [...matches].reduceRight(
                (content, match) => content.slice(0, match.start) + replace(match) + content.slice(match.end),
                source
            );
            if (replaced === source) {
                throw new Error(endingsOnly
                    ? `No changes to apply: ${relativePath} already has those line endings.`
                    : `No changes to apply: the edit leaves ${relativePath} unchanged. Line endings follow the file; to change them, write \\r explicitly in oldString or newString.`);
            }
            await writeFile(target, replaced, 'utf8');

            const diff = unifiedDiff(source, replaced);
            return `Edited ${relativePath} (${matches.length} replacement${matches.length === 1 ? '' : 's'})${diff ? `\n\n${diff}` : ''}`;
        }
    };
}
