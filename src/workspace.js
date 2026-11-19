import path from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveInsideRoot, assertRealInsideRoot } from './lib/paths.js';
import { listDirectory } from './tools/read.js';

// Session-scoped sandbox workspace. The base directory is shared and
// persistent (tmpdir()/rigline by default); every run() gets its own
// session-* subfolder, created lazily — the host staging files via put(),
// or at run start — and removed when the run settles: final answer,
// MaxStepsError, or any other failure, always before returning to the host.
export class Workspace {
    #base;
    #session = null;
    #running = false;

    constructor(baseDir) {
        this.#base = path.resolve(baseDir ?? path.join(tmpdir(), 'rigline'));
        mkdirSync(this.#base, { recursive: true });
    }

    // The host-facing helper surface, exposed as agent.workspace.
    get api() {
        return {
            dir: () => this.#session,
            put: (relativePath, content) => this.#put(relativePath, content),
            get: (relativePath) => this.#get(relativePath, 'utf8'),
            getBytes: (relativePath) => this.#get(relativePath),
            list: (relativePath = '.') => this.#list(relativePath),
            exists: (relativePath) => this.#exists(relativePath)
        };
    }

    // Called at the top of Agent.run(): adopts the session the host staged
    // into (if any) or creates a fresh one. `end()` removes the session
    // folder; the base directory always stays.
    startSession() {
        if (this.#running) {
            throw new Error('This sandboxed agent already has a run() in flight; a sandboxed agent runs one session at a time');
        }
        if (this.#session === null) {
            this.#session = mkdtempSync(path.join(this.#base, 'session-'));
        }
        this.#running = true;
        const dir = this.#session;
        return {
            dir,
            end: async () => {
                this.#running = false;
                this.#session = null;
                await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
        };
    }

    // All helpers resolve inside the current session folder. put() creates
    // the session lazily (staging); the read helpers require one to exist.
    async #resolve(relativePath, { create = false } = {}) {
        if (this.#session === null) {
            if (!create) {
                throw new Error('No session workspace is active: it exists after agent.workspace.put() or while a run() is in flight');
            }
            this.#session = mkdtempSync(path.join(this.#base, 'session-'));
        }
        const target = resolveInsideRoot(this.#session, relativePath);
        await assertRealInsideRoot(this.#session, relativePath, target);
        return target;
    }

    async #put(relativePath, content) {
        if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
            throw new TypeError('workspace.put content must be a string or a Buffer');
        }
        const target = await this.#resolve(relativePath, { create: true });
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }

    async #get(relativePath, encoding) {
        const target = await this.#resolve(relativePath);
        try {
            return await readFile(target, encoding);
        } catch (err) {
            throw new Error(`File not found in the session workspace: ${relativePath}`, { cause: err });
        }
    }

    async #list(relativePath) {
        const target = await this.#resolve(relativePath);
        const targetStat = await stat(target).catch(() => null);
        if (targetStat === null) {
            throw new Error(`Path not found in the session workspace: ${relativePath}`);
        }
        if (!targetStat.isDirectory()) {
            throw new Error(`Path is not a directory in the session workspace: ${relativePath}`);
        }
        return listDirectory(target);
    }

    async #exists(relativePath) {
        const target = await this.#resolve(relativePath);
        return stat(target).then(() => true, () => false);
    }
}
