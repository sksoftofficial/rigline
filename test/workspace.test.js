import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, MaxStepsError } from '../src/Agent.js';
import { readTool } from '../src/tools/index.js';
import {
    completion,
    textMessage,
    toolCallsMessage,
    toolCall,
    makeAgent,
    tempRoot,
    put,
    requestBody
} from './helpers.js';

test('sandboxed: true stages into tmpdir()/rigline session-* and removes it when the run resolves', async (t) => {
    const { agent } = makeAgent(t, [completion(textMessage('done'))], { sandboxed: true });

    await agent.workspace.put('input.txt', 'staged');
    const dir = agent.workspace.dir();
    assert.ok(dir.startsWith(join(tmpdir(), 'rigline', 'session-')), `unexpected session dir: ${dir}`);
    assert.ok(existsSync(dir));

    await agent.run('go');

    assert.ok(!existsSync(dir), 'session folder must be removed when the run resolves');
    assert.ok(existsSync(join(tmpdir(), 'rigline')), 'the base workspace stays');
});

test('built-in tools are auto-registered and run inside the staged session folder', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([
            toolCall('c1', 'read', { path: 'input.txt' }),
            toolCall('c2', 'write', { path: 'out/result.txt', content: 'result data' })
        ])),
        completion(textMessage('done'))
    ], { sandboxed: true });

    await agent.workspace.put('input.txt', 'staged');
    const dir = agent.workspace.dir();

    const result = await agent.run('process input.txt');

    const names = requestBody(fetchMock, 0).tools.map((tool) => tool.function.name);
    assert.deepEqual([...names].sort(), ['edit', 'glob', 'grep', 'patch', 'read', 'write']);

    const toolMsgs = requestBody(fetchMock, 1).messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs[0].content, 'Read file input.txt, lines 1-1\n1: staged');
    assert.equal(toolMsgs[1].content, 'Created file successfully: out/result.txt');
    assert.equal(result.text, 'done');
    assert.ok(!existsSync(dir));
});

test('the session folder is removed even when the run fails (MaxStepsError)', async (t) => {
    const toolTurn = () => completion(toolCallsMessage([toolCall('c', 'read', { path: 'input.txt' })]));
    const { agent } = makeAgent(t, [toolTurn(), toolTurn()], { sandboxed: true, maxSteps: 2 });

    await agent.workspace.put('input.txt', 'x');
    const dir = agent.workspace.dir();

    await assert.rejects(agent.run('go'), MaxStepsError);
    assert.ok(!existsSync(dir));
});

test('a second run gets a fresh session folder', async (t) => {
    const { agent } = makeAgent(t, [
        completion(textMessage('one')),
        completion(textMessage('two'))
    ], { sandboxed: true });

    await agent.workspace.put('input.txt', 'first');
    const firstDir = agent.workspace.dir();
    await agent.run('go');

    await agent.workspace.put('input.txt', 'second');
    const secondDir = agent.workspace.dir();
    assert.notEqual(secondDir, firstDir);

    await agent.run('go again');
    assert.ok(!existsSync(secondDir));
});

test('sandboxed: <path> uses that directory as the base workspace', async (t) => {
    const base = tempRoot(t);
    const { agent } = makeAgent(t, [completion(textMessage('ok'))], { sandboxed: base });

    await agent.workspace.put('a.txt', 'hello');
    const dir = agent.workspace.dir();
    assert.ok(dir.startsWith(join(base, 'session-')), `unexpected session dir: ${dir}`);

    await agent.run('go');

    assert.ok(!existsSync(dir));
    assert.ok(existsSync(base), 'the base directory stays');
});

test('put/get/getBytes/list/exists round-trip inside the session', async (t) => {
    const { agent } = makeAgent(t, [], { sandboxed: tempRoot(t) });

    await agent.workspace.put('sub/a.txt', 'hello');
    await agent.workspace.put('blob.bin', Buffer.from([1, 2, 3]));

    assert.equal(await agent.workspace.get('sub/a.txt'), 'hello');
    assert.deepEqual(await agent.workspace.getBytes('blob.bin'), Buffer.from([1, 2, 3]));
    assert.deepEqual(await agent.workspace.list(), ['sub/', 'blob.bin']);
    assert.deepEqual(await agent.workspace.list('sub'), ['a.txt']);
    assert.equal(await agent.workspace.exists('sub/a.txt'), true);
    assert.equal(await agent.workspace.exists('missing.txt'), false);
    await assert.rejects(agent.workspace.get('missing.txt'), /File not found in the session workspace/);
    await assert.rejects(agent.workspace.put('bad.txt', 5), /content must be a string or a Buffer/);
});

test('read helpers fail clearly before any session exists', async (t) => {
    const { agent } = makeAgent(t, [], { sandboxed: tempRoot(t) });

    assert.equal(agent.workspace.dir(), null);
    await assert.rejects(agent.workspace.get('a.txt'), /No session workspace is active/);
    await assert.rejects(agent.workspace.list(), /No session workspace is active/);
    await assert.rejects(agent.workspace.exists('a.txt'), /No session workspace is active/);
});

test('workspace helpers reject absolute paths and .. escapes', async (t) => {
    const { agent } = makeAgent(t, [], { sandboxed: tempRoot(t) });

    await assert.rejects(agent.workspace.put('/etc/passwd', 'x'), /absolute/);
    await assert.rejects(agent.workspace.put('../escape.txt', 'x'), /escapes/);
});

test('symlinks pointing outside the session are rejected by helpers and tools', async (t) => {
    const outside = tempRoot(t);
    put(outside, 'secret.txt', 'top secret');
    put(outside, join('outsub', 'keep.txt'), 'y');

    const { agent } = makeAgent(t, [], { sandboxed: tempRoot(t) });
    await agent.workspace.put('a.txt', 'x'); // create the session
    const dir = agent.workspace.dir();
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'file-link.txt'));
    symlinkSync(join(outside, 'outsub'), join(dir, 'dir-link'));

    await assert.rejects(agent.workspace.get('file-link.txt'), /symlink/);
    await assert.rejects(agent.workspace.put('dir-link/new.txt', 'x'), /symlink/);
    await assert.rejects(readTool({ root: dir }).execute({ path: 'file-link.txt' }), /symlink/);
});

test('agent.workspace is undefined without sandboxed', async (t) => {
    const { agent } = makeAgent(t, []);
    assert.equal(agent.workspace, undefined);
});

test('sandboxed validation and read/write name collisions', () => {
    const transport = { apiKey: 'k', model: 'm' };
    assert.throws(() => new Agent({ transport, sandboxed: 42 }), /sandboxed must be true or a workspace directory path string/);
    assert.throws(() => new Agent({ transport, sandboxed: '' }), /sandboxed must be true or a workspace directory path string/);
    assert.throws(
        () => new Agent({ transport, sandboxed: true, tools: [readTool({ root: '/tmp/rigline-x' })] }),
        /sandboxed already registers/
    );
});
