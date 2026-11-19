import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolveInsideRoot, assertRealInsideRoot } from '../lib/paths.js';

// Conventions inherited from opencode's write tool: overwrite in place,
// create parent directories, and a result that distinguishes creating from
// overwriting so the model knows what happened.
export function writeTool({ root } = {}) {
    if (typeof root !== 'string' || root.trim().length === 0) {
        throw new TypeError('writeTool requires a root option: the base directory all writes are confined to');
    }
    const rootDir = path.resolve(root);

    return {
        name: 'write',
        description: 'Writes a file to the local filesystem, overwriting if one exists. Missing parent directories are created automatically. Use this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the working root directory.' },
                content: { type: 'string', description: 'Full UTF-8 content to write to the file.' }
            },
            required: ['path', 'content'],
            additionalProperties: false
        },
        execute: async (args) => {
            if (typeof args?.content !== 'string') {
                throw new Error('content must be a string');
            }
            const relativePath = args.path;
            const target = resolveInsideRoot(rootDir, relativePath);
            await assertRealInsideRoot(rootDir, relativePath, target);
            const existed = await stat(target).then(() => true, () => false);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, args.content, 'utf8');
            return `${existed ? 'Wrote' : 'Created'} file successfully: ${relativePath}`;
        }
    };
}
