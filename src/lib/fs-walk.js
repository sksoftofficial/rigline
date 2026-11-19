import path from 'node:path';
import { readdir } from 'node:fs/promises';

const ALWAYS_SKIP = new Set(['.git']);

// Depth-first file walk, alphabetical within each directory. Hidden entries
// (dot-prefixed) are skipped unless `hidden` is true; .git is always skipped.
// Symlinked directories are never followed — readdir Dirents report them as
// symlinks, not directories — so walks cannot escape the root or cycle.
export async function* walkFiles(dir, { hidden = false } = {}) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (!hidden && entry.name.startsWith('.')) {
            continue;
        }
        if (ALWAYS_SKIP.has(entry.name)) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkFiles(full, { hidden });
        } else if (entry.isFile()) {
            yield full;
        }
    }
}
