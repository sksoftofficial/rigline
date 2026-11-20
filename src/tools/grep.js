import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { resolveInsideRoot, assertRealInsideRoot, sessionWorkspaceRoot } from '../lib/paths.js';
import { walkFiles } from '../lib/fs-walk.js';
import { globMatches } from '../lib/glob.js';

// Ported from opencode's grep tool, with the search implemented in pure
// Node instead of ripgrep: per-line matching, binary files skipped, hidden
// entries and .git never searched, no gitignore handling.

const DEFAULT_LIMIT = 100;
const MAX_LINE_LENGTH = 2000;

const TRUNCATION_NOTE = (count) => `(Results are truncated: showing first ${count} results. Consider using a more specific path or pattern.)`;

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function grepTool() {
    return {
        name: 'grep',
        requiresWorkspace: true,
        description: 'Search file contents using a regular expression or literal text. Matches are grouped by file and shown as "  Line N: text". Use include to filter files by glob (for example, "*.js" or "*.{ts,tsx}"). Hidden files and directories are not searched; binary files are skipped.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regular expression or literal text to match in file contents.' },
                path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace.' },
                include: { type: 'string', description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}").' },
                literal: { type: 'boolean', description: 'Treat `pattern` as exact text instead of a regular expression (default: false).' },
                caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching (default: true).' },
                limit: { type: 'integer', description: `Maximum number of matching lines to return (default: ${DEFAULT_LIMIT}).` }
            },
            required: ['pattern'],
            additionalProperties: false
        },
        execute: async (args, context) => {
            const rootDir = sessionWorkspaceRoot(context, 'grep');
            if (typeof args?.pattern !== 'string' || args.pattern.length === 0) {
                throw new Error('pattern must be a non-empty string');
            }
            if (args?.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
                throw new Error('Limit must be a positive integer');
            }
            const caseSensitive = args?.caseSensitive !== false;
            let matcher;
            try {
                matcher = new RegExp(args.literal === true ? escapeRegex(args.pattern) : args.pattern, caseSensitive ? '' : 'i');
            } catch (err) {
                throw new Error(`Invalid regex pattern: ${err.message}`);
            }

            const relativePath = args?.path ?? '.';
            const target = resolveInsideRoot(rootDir, relativePath);
            await assertRealInsideRoot(rootDir, relativePath, target);
            const targetStat = await stat(target).catch(() => null);
            if (targetStat === null) {
                throw new Error(`Path not found: ${relativePath}`);
            }
            const limit = args?.limit ?? DEFAULT_LIMIT;
            const matches = [];
            let truncated = false;

            const files = targetStat.isFile()
                ? (async function* generate() { yield target; }())
                : walkFiles(target);
            for await (const file of files) {
                if (truncated) {
                    break;
                }
                const rel = path.relative(rootDir, file);
                if (args?.include !== undefined && !globMatches(args.include, rel)) {
                    continue;
                }
                const content = await readFile(file, 'utf8').catch(() => null);
                if (content === null || content.includes('\0')) {
                    continue;
                }
                const lines = content.split('\n');
                if (lines[lines.length - 1] === '') {
                    lines.pop();
                }
                for (let i = 0; i < lines.length; i += 1) {
                    if (!matcher.test(lines[i])) {
                        continue;
                    }
                    if (matches.length >= limit) {
                        truncated = true;
                        break;
                    }
                    const text = lines[i].length > MAX_LINE_LENGTH
                        ? `${lines[i].slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`
                        : lines[i];
                    matches.push({ path: rel, line: i + 1, text });
                }
            }

            if (matches.length === 0) {
                return 'No matches found';
            }
            const out = [`Found ${matches.length} matches`];
            let current = '';
            for (const match of matches) {
                if (current !== match.path) {
                    if (current) {
                        out.push('');
                    }
                    current = match.path;
                    out.push(`${match.path}:`);
                }
                out.push(`  Line ${match.line}: ${match.text}`);
            }
            if (truncated) {
                out.push('', TRUNCATION_NOTE(matches.length));
            }
            return out.join('\n');
        }
    };
}
