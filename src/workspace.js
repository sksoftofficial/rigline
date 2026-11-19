import path from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveInsideRoot, assertRealInsideRoot } from './lib/paths.js';
import { listDirectory } from './tools/read.js';

// Session-scoped sandbox workspace. The base directory is shared and
// persistent (the Agent `workspace` option, or tmpdir()/rigline by default);
// every run() gets its own session-* subfolder, created lazily — the host
// staging files via put(), or at run start — and removed when the run
// settles: final answer, MaxStepsError, or any other failure, always before
// returning to the host.
export class Workspace {
    _base;
    _session = null;
    _running = false;

    constructor(baseDir) {
        this._base = path.resolve(baseDir ?? path.join(tmpdir(), 'rigline'));
        mkdirSync(this._base, { recursive: true });
    }

    // The host-facing helper surface, exposed as agent.workspace.
    get api() {
        return {
            dir: () => this._session,
            put: (relativePath, content) => this._put(relativePath, content),
            get: (relativePath) => this._get(relativePath, 'utf8'),
            getBytes: (relativePath) => this._get(relativePath),
            list: (relativePath = '.') => this._list(relativePath),
            exists: (relativePath) => this._exists(relativePath)
        };
    }

    // Called at the top of Agent.run(): adopts the session the host staged
    // into (if any) or creates a fresh one. `end()` removes the session
    // folder; the base directory always stays.
    startSession() {
        if (this._running) {
            throw new Error('This agent already has a run() in flight; workspace sessions run one at a time');
        }
        if (this._session === null) {
            this._session = mkdtempSync(path.join(this._base, 'session-'));
        }
        this._running = true;
        const dir = this._session;
        return {
            dir,
            end: async () => {
                this._running = false;
                this._session = null;
                await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
        };
    }

    // All helpers resolve inside the current session folder. put() creates
    // the session lazily (staging); the read helpers require one to exist.
    async _resolve(relativePath, { create = false } = {}) {
        if (this._session === null) {
            if (!create) {
                throw new Error('No session workspace is active: it exists after agent.workspace.put() or while a run() is in flight');
            }
            this._session = mkdtempSync(path.join(this._base, 'session-'));
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
