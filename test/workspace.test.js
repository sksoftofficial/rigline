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

test('every agent gets a session workspace: default base tmpdir()/rigline, removed when the run resolves', async (t) => {
    const { agent } = makeAgent(t, [completion(textMessage('done'))]);

    await agent.workspace.put('input.txt', 'staged');
    const dir = agent.workspace.dir();
    assert.ok(dir.startsWith(join(tmpdir(), 'rigline', 'session-')), `unexpected session dir: ${dir}`);
    assert.ok(existsSync(dir));

    await agent.run('go');

    assert.ok(!existsSync(dir), 'session folder must be removed when the run resolves');
    assert.ok(existsSync(join(tmpdir(), 'rigline')), 'the base workspace stays');
});

test('the six built-in file tools are always registered and run inside the session folder', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([
            toolCall('c1', 'read', { path: 'input.txt' }),
            toolCall('c2', 'write', { path: 'out/result.txt', content: 'result data' })
        ])),
        completion(textMessage('done'))
    ]);

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

test('custom tools receive the session folder as execute context and can use it for filesystem work', async (t) => {
    let seenDir = null;
    const writer = {
        name: 'note',
        description: 'writes a note',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        execute: async (args, context) => {
            seenDir = context?.workspaceDir;
            return 'noted';
        }
    };
    const { agent } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'note', { text: 'hi' })])),
        completion(textMessage('done'))
    ], { tools: [writer] });
    await agent.workspace.put('seed.txt', 'x'); // stages the session run() will adopt
    const stagedDir = agent.workspace.dir();

    await agent.run('take a note');

    assert.equal(seenDir, stagedDir, 'execute context must be the session folder the run adopted');
    assert.ok(typeof seenDir === 'string' && seenDir.includes('session-'));
});

test('the session folder is removed even when the run fails (MaxStepsError)', async (t) => {
    const toolTurn = () => completion(toolCallsMessage([toolCall('c', 'read', { path: 'input.txt' })]));
    const { agent } = makeAgent(t, [toolTurn(), toolTurn()], { maxSteps: 2 });

    await agent.workspace.put('input.txt', 'x');
    const dir = agent.workspace.dir();

    await assert.rejects(agent.run('go'), MaxStepsError);
    assert.ok(!existsSync(dir));
});

test('a second run gets a fresh session folder', async (t) => {
    const { agent } = makeAgent(t, [
        completion(textMessage('one')),
        completion(textMessage('two'))
    ]);

    await agent.workspace.put('input.txt', 'first');
    const firstDir = agent.workspace.dir();
    await agent.run('go');

    await agent.workspace.put('input.txt', 'second');
    const secondDir = agent.workspace.dir();
    assert.notEqual(secondDir, firstDir);

    await agent.run('go again');
    assert.ok(!existsSync(secondDir));
});

test('workspace: <path> uses that directory as the base workspace', async (t) => {
    const base = tempRoot(t);
    const { agent } = makeAgent(t, [completion(textMessage('ok'))], { workspace: base });

    await agent.workspace.put('a.txt', 'hello');
    const dir = agent.workspace.dir();
    assert.ok(dir.startsWith(join(base, 'session-')), `unexpected session dir: ${dir}`);

    await agent.run('go');

    assert.ok(!existsSync(dir));
    assert.ok(existsSync(base), 'the base directory stays');
});

test('put/get/getBytes/list/exists round-trip inside the session', async (t) => {
    const { agent } = makeAgent(t, [], { workspace: tempRoot(t) });

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
    const { agent } = makeAgent(t, [], { workspace: tempRoot(t) });

    assert.equal(agent.workspace.dir(), null);
    await assert.rejects(agent.workspace.get('a.txt'), /No session workspace is active/);
    await assert.rejects(agent.workspace.list(), /No session workspace is active/);
    await assert.rejects(agent.workspace.exists('a.txt'), /No session workspace is active/);
});

test('workspace helpers reject absolute paths and .. escapes', async (t) => {
    const { agent } = makeAgent(t, [], { workspace: tempRoot(t) });

    await assert.rejects(agent.workspace.put('/etc/passwd', 'x'), /absolute/);
    await assert.rejects(agent.workspace.put('../escape.txt', 'x'), /escapes/);
});

test('symlinks pointing outside the session are rejected by helpers and tools', async (t) => {
    const outside = tempRoot(t);
    put(outside, 'secret.txt', 'top secret');
    put(outside, join('outsub', 'keep.txt'), 'y');

    const { agent } = makeAgent(t, [], { workspace: tempRoot(t) });
    await agent.workspace.put('a.txt', 'x'); // create the session
    const dir = agent.workspace.dir();
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'file-link.txt'));
    symlinkSync(join(outside, 'outsub'), join(dir, 'dir-link'));

    await assert.rejects(agent.workspace.get('file-link.txt'), /symlink/);
    await assert.rejects(agent.workspace.put('dir-link/new.txt', 'x'), /symlink/);
    await assert.rejects(readTool().execute({ path: 'file-link.txt' }, { workspaceDir: dir }), /symlink/);
});

test('workspace option validation; a same-name user tool overrides the built-in', async (t) => {
    const transport = { apiKey: 'k', model: 'm' };
    assert.throws(() => new Agent({ transport, workspace: 42 }), /workspace must be a directory path string/);
    assert.throws(() => new Agent({ transport, workspace: '' }), /workspace must be a directory path string/);

    const mine = {
        name: 'read',
        description: 'host-provided read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => 'MINE'
    };
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'read', { path: 'x' })])),
        completion(textMessage('done'))
    ], { tools: [mine] });

    const result = await agent.run('go');

    const toolMsg = requestBody(fetchMock, 1).messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, 'MINE', 'the user tool must win over the built-in');
    assert.equal(result.text, 'done');
});
