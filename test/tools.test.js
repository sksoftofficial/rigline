import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readTool, writeTool } from '../src/tools/index.js';
import { tempRoot, put } from './helpers.js';

test('read returns numbered lines with a header for a file', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'line one\nline two\n');
    const tool = readTool();

    assert.equal(
        await tool.execute({ path: 'a.txt' }, { workspaceDir: root }),
        'Read file a.txt, lines 1-2\n1: line one\n2: line two'
    );
});

test('read handles files without a trailing newline and empty files', async (t) => {
    const root = tempRoot(t);
    put(root, 'single.txt', 'only line');
    put(root, 'empty.txt', '');
    const tool = readTool();

    assert.equal(await tool.execute({ path: 'single.txt' }, { workspaceDir: root }), 'Read file single.txt, lines 1-1\n1: only line');
    assert.equal(await tool.execute({ path: 'empty.txt' }, { workspaceDir: root }), 'Read file empty.txt, 0 lines');
});

test('read strips trailing carriage returns (LF view) from CRLF files', async (t) => {
    const root = tempRoot(t);
    put(root, 'crlf.txt', 'first\r\nsecond\r\n');
    const tool = readTool();

    assert.equal(
        await tool.execute({ path: 'crlf.txt' }, { workspaceDir: root }),
        'Read file crlf.txt, lines 1-2\n1: first\n2: second'
    );
});

test('read paginates with offset and limit and teaches how to continue', async (t) => {
    const root = tempRoot(t);
    put(root, 'ten.txt', Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'));
    const tool = readTool();

    const page = await tool.execute({ path: 'ten.txt', offset: 3, limit: 4 }, { workspaceDir: root });
    assert.equal(
        page,
        [
            'Read file ten.txt, lines 3-6',
            '3: L3',
            '4: L4',
            '5: L5',
            '6: L6',
            '[Output truncated. Continue reading with offset: 7]'
        ].join('\n')
    );

    const lastPage = await tool.execute({ path: 'ten.txt', offset: 8, limit: 4 }, { workspaceDir: root });
    assert.ok(!lastPage.includes('Output truncated'), 'final page has no continuation marker');
    assert.equal(lastPage.split('\n')[0], 'Read file ten.txt, lines 8-10');
});

test('read negative offset counts back from the end of a file', async (t) => {
    const root = tempRoot(t);
    put(root, 'ten.txt', Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'));
    const tool = readTool();

    const tail = await tool.execute({ path: 'ten.txt', offset: -3 }, { workspaceDir: root });
    assert.equal(tail.split('\n')[0], 'Read file ten.txt, lines 8-10');
    assert.ok(tail.includes('10: L10'));
});

test('read reports an offset past the end instead of failing silently', async (t) => {
    const root = tempRoot(t);
    put(root, 'ten.txt', Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'));
    const tool = readTool();

    assert.equal(
        await tool.execute({ path: 'ten.txt', offset: 99 }, { workspaceDir: root }),
        'Read file ten.txt, 0 lines (offset 99 is past the end; the file has 10 lines)'
    );
});

test('read truncates overlong lines and bounds total output', async (t) => {
    const root = tempRoot(t);
    put(root, 'long.txt', `${'x'.repeat(2500)}\nshort\n`);
    put(root, 'fat.txt', Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${'y'.repeat(30)}`).join('\n'));
    const tool = readTool();

    const long = await tool.execute({ path: 'long.txt' }, { workspaceDir: root });
    assert.ok(long.includes(`1: ${'x'.repeat(2000)}... (line truncated to 2000 chars)`));
    assert.ok(long.includes('2: short'));

    // ~66KB of text must stop at the 50KB output bound with a continuation marker.
    const fat = await tool.execute({ path: 'fat.txt' }, { workspaceDir: root });
    assert.ok(fat.includes('[Output truncated. Continue reading with offset:'));
    const fatLines = fat.split('\n');
    assert.ok(fatLines.length < 2000, `expected bounded output, got ${fatLines.length} lines`);
});

test('read refuses binary files', async (t) => {
    const root = tempRoot(t);
    put(root, 'blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]));
    const tool = readTool();

    await assert.rejects(tool.execute({ path: 'blob.bin' }, { workspaceDir: root }), /Cannot read binary file: blob\.bin/);
});

test('read lists a directory: directories first, trailing slash, header', async (t) => {
    const root = tempRoot(t);
    put(root, 'zeta.txt', 'z');
    put(root, join('sub', 'inner.txt'), 'i');
    put(root, 'alpha.txt', 'a');
    const tool = readTool();

    assert.equal(
        await tool.execute({ path: '.' }, { workspaceDir: root }),
        'Read directory ., entries 1-3\nsub/\nalpha.txt\nzeta.txt'
    );
    assert.equal(
        await tool.execute({ path: 'sub' }, { workspaceDir: root }),
        'Read directory sub, entries 1-1\ninner.txt'
    );
});

test('read paginates directory listings', async (t) => {
    const root = tempRoot(t);
    for (let i = 1; i <= 5; i += 1) {
        put(root, `f${i}.txt`, 'x');
    }
    const tool = readTool();

    const page = await tool.execute({ path: '.', offset: 2, limit: 2 }, { workspaceDir: root });
    assert.equal(
        page,
        [
            'Read directory ., entries 2-3',
            'f2.txt',
            'f3.txt',
            '[Output truncated. Continue reading with offset: 4]'
        ].join('\n')
    );
});

test('read rejects a negative offset for directories', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'x');
    const tool = readTool();
    await assert.rejects(tool.execute({ path: '.', offset: -1 }, { workspaceDir: root }), /negative offset only works for files/);
});

test('read validates offset and limit', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'x');
    const tool = readTool();
    await assert.rejects(tool.execute({ path: 'a.txt', limit: 0 }, { workspaceDir: root }), /Limit must be a positive integer/);
    await assert.rejects(tool.execute({ path: 'a.txt', offset: 0 }, { workspaceDir: root }), /Offset must be a non-zero integer/);
    await assert.rejects(tool.execute({ path: 'a.txt', offset: 1.5 }, { workspaceDir: root }), /Offset must be a non-zero integer/);
});

test('read missing path teaches: did-you-mean among siblings', async (t) => {
    const root = tempRoot(t);
    put(root, 'notes.txt', 'x');
    put(root, 'notary.txt', 'x');
    const tool = readTool();

    await assert.rejects(tool.execute({ path: 'note.txt' }, { workspaceDir: root }), (err) => {
        assert.match(err.message, /File not found: note\.txt/);
        assert.match(err.message, /Did you mean one of these\?\nnotes\.txt/);
        return true;
    });
});

test('read missing folder teaches: nearest folder that exists', async (t) => {
    const root = tempRoot(t);
    put(root, 'real.txt', 'x');
    const tool = readTool();

    await assert.rejects(tool.execute({ path: 'nope/deep.txt' }, { workspaceDir: root }), (err) => {
        assert.match(err.message, /File not found: nope\/deep\.txt/);
        assert.match(err.message, /The folder nope does not exist\. The nearest folder that does is \./);
        return true;
    });
});

test('read keeps path confinement: absolute paths and .. escapes', async (t) => {
    const root = tempRoot(t);
    const tool = readTool();
    await assert.rejects(tool.execute({ path: '/etc/passwd' }, { workspaceDir: root }), /absolute/);
    await assert.rejects(tool.execute({ path: '../outside.txt' }, { workspaceDir: root }), /escapes/);
    await assert.rejects(tool.execute({ path: 'sub/../../outside.txt' }, { workspaceDir: root }), /escapes/);
    await assert.rejects(tool.execute({}, { workspaceDir: root }), /non-empty/);
});

test('read and write reject symlinks that escape the root', async (t) => {
    const root = tempRoot(t);
    const outside = tempRoot(t);
    put(outside, 'secret.txt', 'top secret');
    put(outside, join('outsub', 'keep.txt'), 'y');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'file-link.txt'));
    symlinkSync(join(outside, 'outsub'), join(root, 'dir-link'));

    const read = readTool();
    const write = writeTool();

    await assert.rejects(read.execute({ path: 'file-link.txt' }, { workspaceDir: root }), /symlink/);
    await assert.rejects(write.execute({ path: 'file-link.txt', content: 'x' }, { workspaceDir: root }), /symlink/);
    // new file through a symlinked directory is caught via its nearest
    // existing ancestor
    await assert.rejects(write.execute({ path: 'dir-link/new.txt', content: 'x' }, { workspaceDir: root }), /symlink/);
});

test('write creates nested files and distinguishes create from overwrite', async (t) => {
    const root = tempRoot(t);
    const tool = writeTool();

    assert.equal(
        await tool.execute({ path: 'deep/nested/file.txt', content: 'line1\n' }, { workspaceDir: root }),
        'Created file successfully: deep/nested/file.txt'
    );
    assert.equal(readFileSync(join(root, 'deep', 'nested', 'file.txt'), 'utf8'), 'line1\n');

    assert.equal(
        await tool.execute({ path: 'deep/nested/file.txt', content: 'line2\n' }, { workspaceDir: root }),
        'Wrote file successfully: deep/nested/file.txt'
    );
    assert.equal(readFileSync(join(root, 'deep', 'nested', 'file.txt'), 'utf8'), 'line2\n');
});

test('write rejects absolute paths, escapes, and non-string content', async (t) => {
    const root = tempRoot(t);
    const tool = writeTool();
    await assert.rejects(tool.execute({ path: '/tmp/evil', content: 'x' }, { workspaceDir: root }), /absolute/);
    await assert.rejects(tool.execute({ path: '../evil', content: 'x' }, { workspaceDir: root }), /escapes/);
    await assert.rejects(tool.execute({ path: 'ok.txt', content: 5 }, { workspaceDir: root }), /content must be a string/);
    await assert.rejects(tool.execute({ path: 'ok.txt' }, { workspaceDir: root }), /content must be a string/);
});

test('read/write without an active session workspace context fail with a teaching error', async () => {
    await assert.rejects(readTool().execute({ path: 'a.txt' }), /requires an active agent session workspace/);
    await assert.rejects(writeTool().execute({ path: 'a.txt', content: 'x' }), /requires an active agent session workspace/);
});

test('tool descriptors match the OpenAI function-calling shape', () => {
    for (const tool of [readTool(), writeTool()]) {
        assert.equal(typeof tool.name, 'string');
        assert.equal(typeof tool.description, 'string');
        assert.equal(tool.parameters.type, 'object');
        assert.equal(typeof tool.execute, 'function');
    }
});
