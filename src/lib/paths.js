import path from 'node:path';
import { realpath } from 'node:fs/promises';

// Resolve `relativePath` inside `root`, refusing absolute paths and any path
// that lexically escapes the root. Containment is lexical only: a symlink
// created inside the root can still point outside it — pair with
// assertRealInsideRoot to close that hole.
export function resolveInsideRoot(root, relativePath) {
    if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
        throw new Error('path must be a non-empty string');
    }
    if (path.isAbsolute(relativePath)) {
        throw new Error(`path must be relative to the root directory (${root}), got absolute path: '${relativePath}'`);
    }
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`path escapes the root directory (${root}): '${relativePath}'`);
    }
    return resolved;
}

// After the lexical check, verify that the real path of the target — or of
// its nearest existing ancestor, for files that do not exist yet — stays
// inside the real path of the root. This rejects symlinks inside the root
// that point outside it. Best effort: a symlink swapped in after this check
// but before the IO still escapes (TOCTOU); pure Node exposes no O_NOFOLLOW.
export async function assertRealInsideRoot(rootDir, relativePath, target) {
    const realRoot = await realpath(rootDir);
    let probe = target;
    for (;;) {
        const real = await realpath(probe).catch(() => null);
        if (real !== null) {
            const relative = path.relative(realRoot, real);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw new Error(`path escapes the root directory (${rootDir}) via a symlink: '${relativePath}'`);
            }
            return;
        }
        const parent = path.dirname(probe);
        if (parent === probe) {
            throw new Error(`path escapes the root directory (${rootDir}): '${relativePath}'`);
        }
        probe = parent;
    }
}
