import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveInsideRoot, assertRealInsideRoot } from '../lib/paths.js';
import { walkFiles } from '../lib/fs-walk.js';
import { globMatches } from '../lib/glob.js';

// Ported from opencode's glob tool, with the walk implemented in pure Node
// instead of ripgrep: no gitignore handling, .git always skipped, symlinked
// directories never followed.

const DEFAULT_LIMIT = 100;

const TRUNCATION_NOTE = (count) => `(Results are truncated: showing first ${count} results. Consider using a more specific path or pattern.)`;

export function globTool({ root } = {}) {
    if (typeof root !== 'string' || root.trim().length === 0) {
        throw new TypeError('globTool requires a root option: the base directory all searches are confined to');
    }
    const rootDir = path.resolve(root);

    return {
        name: 'glob',
        description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.md", "**/*.{json,md}"). Returns matching file paths, one per line, when you need to find files by name or extension. Hidden files (dot-prefixed) are skipped unless hidden is true.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern to match file paths against.' },
                path: { type: 'string', description: 'Directory to search. Defaults to the working root directory.' },
                hidden: { type: 'boolean', description: 'Include hidden files and directories (default: false).' },
                limit: { type: 'integer', description: `Maximum number of matching files to return (default: ${DEFAULT_LIMIT}).` }
            },
            required: ['pattern'],
            additionalProperties: false
        },
        execute: async (args) => {
            if (typeof args?.pattern !== 'string' || args.pattern.length === 0) {
                throw new Error('pattern must be a non-empty string');
            }
            if (args?.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
                throw new Error('Limit must be a positive integer');
            }
            const relativePath = args?.path ?? '.';
            const target = resolveInsideRoot(rootDir, relativePath);
            await assertRealInsideRoot(rootDir, relativePath, target);
            const targetStat = await stat(target).catch(() => null);
            if (targetStat === null) {
                throw new Error(`Directory not found: ${relativePath}`);
            }
            if (!targetStat.isDirectory()) {
                throw new Error(`Path is not a directory: ${relativePath}`);
            }

            const hidden = args?.hidden === true;
            const limit = args?.limit ?? DEFAULT_LIMIT;
            const results = [];
            let truncated = false;
            for await (const file of walkFiles(target, { hidden })) {
                const rel = path.relative(rootDir, file);
                if (globMatches(args.pattern, rel)) {
                    if (results.length < limit) {
                        results.push(rel);
                    } else {
                        truncated = true;
                        break;
                    }
                }
            }

            const lines = results.length === 0 ? ['No files found'] : results;
            if (truncated) {
                lines.push('', TRUNCATION_NOTE(results.length));
            }
            return lines.join('\n');
        }
    };
}
