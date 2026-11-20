import path from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveInsideRoot, assertRealInsideRoot } from './lib/paths.js';
import { listDirectory } from './tools/read.js';

// Session-scoped sandbox workspace. The base directory is shared and
// persistent (the Agent `workspace` option, or tmpdir()/rigline by default);
// every run() gets its own session-* subfolder. Nothing touches the disk up
// front: the base and the session folder materialize lazily on first real
// use — the host staging files via put(), a file tool executing mid-run, or
// dir() while a run is in flight — so a run that never touches files pays
// zero filesystem syscalls. The session folder is removed when the run
// settles: final answer, MaxStepsError, or any other failure, always before
// returning to the host.
export class Workspace {
    _base;
    _session = null;
    _running = false;

    constructor(baseDir) {
        this._base = path.resolve(baseDir ?? path.join(tmpdir(), 'rigline'));
    }

    // The host-facing helper surface, exposed as agent.workspace. dir() is a
    // pure read outside a run (null until something stages a session); while
    // a run is in flight it materializes the session, matching the guarantee
    // it always gave: a real folder whenever a run is on.
    get api() {
        return {
            dir: () => (this._running && this._session === null ? this._ensureSession() : this._session),
            put: (relativePath, content) => this._put(relativePath, content),
            get: (relativePath) => this._get(relativePath, 'utf8'),
            getBytes: (relativePath) => this._get(relativePath),
            list: (relativePath = '.') => this._list(relativePath),
            exists: (relativePath) => this._exists(relativePath)
        };
    }

    // Called at the top of Agent.run(): adopts the session the host staged
    // into (if any) and marks the run window. Creates nothing — the session
    // folder materializes on first use via the dir getter (how tools reach
    // it) or put(). `end()` removes the session folder if it ever
    // materialized; the base directory always stays.
    startSession() {
        if (this._running) {
            throw new Error('This agent already has a run() in flight; workspace sessions run one at a time');
        }
        this._running = true;
        const ws = this;
        return {
            get dir() {
                return ws._ensureSession();
            },
            end: async () => {
                ws._running = false;
                const dir = ws._session;
                ws._session = null;
                if (dir !== null) {
                    await rm(dir, { recursive: true, force: true }).catch(() => {});
                }
            }
        };
    }

    // Materializes the session folder (and the base directory) on demand.
    // Sync on purpose: dir() and the tool-execution context hand out the
    // folder as a plain string, and this only ever runs right before real IO
    // inside that folder anyway.
    _ensureSession() {
        if (this._session === null) {
            mkdirSync(this._base, { recursive: true });
            this._session = mkdtempSync(path.join(this._base, 'session-'));
        }
        return this._session;
    }

    // All helpers resolve inside the current session folder. put() creates
    // the session lazily (staging); the read helpers require one to exist.
    async _resolve(relativePath, { create = false } = {}) {
        if (this._session === null) {
            if (!create) {
                throw new Error('No session workspace is active: it exists after agent.workspace.put() or while a run() is in flight');
            }
            this._ensureSession();
        }
        const target = resolveInsideRoot(this._session, relativePath);
        await assertRealInsideRoot(this._session, relativePath, target);
        return target;
    }

    async _put(relativePath, content) {
        if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
            throw new TypeError('workspace.put content must be a string or a Buffer');
        }
        const target = await this._resolve(relativePath, { create: true });
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }

    async _get(relativePath, encoding) {
        const target = await this._resolve(relativePath);
        try {
            return await readFile(target, encoding);
        } catch (err) {
            throw new Error(`File not found in the session workspace: ${relativePath}`, { cause: err });
        }
    }

    async _list(relativePath) {
        const target = await this._resolve(relativePath);
        const targetStat = await stat(target).catch(() => null);
        if (targetStat === null) {
            throw new Error(`Path not found in the session workspace: ${relativePath}`);
        }
        if (!targetStat.isDirectory()) {
            throw new Error(`Path is not a directory in the session workspace: ${relativePath}`);
        }
        return listDirectory(target);
    }

    async _exists(relativePath) {
        const target = await this._resolve(relativePath);
        return stat(target).then(() => true, () => false);
    }
}
