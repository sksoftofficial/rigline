import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { patchTool } from '../src/tools/index.js';
import { tempRoot, put } from './helpers.js';

test('patch adds, updates, and deletes files in one atomic operation', async (t) => {
    const root = tempRoot(t);
    put(root, 'app.py', 'def greet():\n    print("Hi")\n');
    put(root, 'obsolete.txt', 'bye\n');
    const tool = patchTool({ root });

    const out = await tool.execute({
        patchText: [
            '*** Begin Patch',
            '*** Add File: hello.txt',
            '+Hello world',
            '*** Update File: app.py',
            '@@ def greet():',
            '-    print("Hi")',
            '+    print("Hello, world!")',
            '*** Delete File: obsolete.txt',
            '*** End Patch'
        ].join('\n')
    });

    assert.equal(readFileSync(`${root}/hello.txt`, 'utf8'), 'Hello world\n');
    assert.equal(readFileSync(`${root}/app.py`, 'utf8'), 'def greet():\n    print("Hello, world!")\n');
    assert.ok(!existsSync(`${root}/obsolete.txt`));
    assert.match(out, /^Applied patch \(3 operations\):/);
    assert.match(out, /- Added hello\.txt/);
    assert.match(out, /- Updated app\.py/);
    assert.match(out, /- Deleted obsolete\.txt/);
    assert.match(out, / def greet\(\):/);
});

test('patch add creates parent directories and appends the trailing newline', async (t) => {
    const root = tempRoot(t);
    const tool = patchTool({ root });

    await tool.execute({
        patchText: [
            '*** Begin Patch',
            '*** Add File: deep/nested/new.txt',
            '+one',
            '+two',
            '*** End Patch'
        ].join('\n')
    });

    assert.equal(readFileSync(`${root}/deep/nested/new.txt`, 'utf8'), 'one\ntwo\n');
});

test('patch update positions by @@ context and keeps surrounding lines', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', ['start', 'alpha', 'beta', 'gamma', 'end'].join('\n'));
    const tool = patchTool({ root });

    await tool.execute({
        patchText: [
            '*** Begin Patch',
            '*** Update File: a.txt',
            '@@ beta',
            '-gamma',
            '+GAMMA',
            '*** End Patch'
        ].join('\n')
    });

    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'start\nalpha\nbeta\nGAMMA\nend');
});

test('patch update with Move to writes the new path and removes the old one', async (t) => {
    const root = tempRoot(t);
    put(root, 'old.ts', 'export const x = 1;\n');
    const tool = patchTool({ root });

    await tool.execute({
        patchText: [
            '*** Begin Patch',
            '*** Update File: old.ts',
            '*** Move to: renamed/deep.ts',
            '-export const x = 1;',
            '+export const x = 2;',
            '*** End Patch'
        ].join('\n')
    });

    assert.ok(!existsSync(`${root}/old.ts`));
    assert.equal(readFileSync(`${root}/renamed/deep.ts`, 'utf8'), 'export const x = 2;\n');
});

test('patch chains operations: add then update the same file', async (t) => {
    const root = tempRoot(t);
    const tool = patchTool({ root });

    await tool.execute({
        patchText: [
            '*** Begin Patch',
            '*** Add File: chained.txt',
            '+first',
            '*** Update File: chained.txt',
            '-first',
            '+second',
            '*** End Patch'
        ].join('\n')
    });

    assert.equal(readFileSync(`${root}/chained.txt`, 'utf8'), 'second\n');
});

test('patch verifies everything first: one bad hunk applies nothing', async (t) => {
    const root = tempRoot(t);
    put(root, 'keep.txt', 'untouched\n');
    const tool = patchTool({ root });

    await assert.rejects(
        tool.execute({
            patchText: [
                '*** Begin Patch',
                '*** Add File: would-be-added.txt',
                '+content',
                '*** Delete File: missing.txt',
                '*** End Patch'
            ].join('\n')
        }),
        /cannot delete missing\.txt: file does not exist/
    );

    assert.ok(!existsSync(`${root}/would-be-added.txt`), 'nothing may be written when verification fails');
    assert.equal(readFileSync(`${root}/keep.txt`, 'utf8'), 'untouched\n');
});

test('patch update rejects a context line that does not match the file', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'one\ntwo\n');
    const tool = patchTool({ root });

    await assert.rejects(
        tool.execute({
            patchText: [
                '*** Begin Patch',
                '*** Update File: a.txt',
                '@@ nonexistent context',
                '-one',
                '+1',
                '*** End Patch'
            ].join('\n')
        }),
        /could not find context "nonexistent context" in a\.txt/
    );
    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'one\ntwo\n');
});

test('patch update rejects a minus line that is not in the file', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'one\ntwo\n');
    const tool = patchTool({ root });

    await assert.rejects(
        tool.execute({
            patchText: [
                '*** Begin Patch',
                '*** Update File: a.txt',
                '-tree',
                '+3',
                '*** End Patch'
            ].join('\n')
        }),
        /could not find line "tree" in a\.txt/
    );
});

test('patch End of File truncates the remainder of an update', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'keep\njunk1\njunk2\n');
    const tool = patchTool({ root });

    await tool.execute({
        patchText: [
            '*** Begin Patch',
            '*** Update File: a.txt',
            '@@ keep',
            '-junk1',
            '-junk2',
            '*** End of File',
            '*** End Patch'
        ].join('\n')
    });

    // Byte-level result: everything after 'keep' is dropped, including the
    // final newline that used to follow junk2.
    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'keep');
});

test('patch refuses duplicate adds and malformed patches', async (t) => {
    const root = tempRoot(t);
    put(root, 'exists.txt', 'x\n');
    const tool = patchTool({ root });

    await assert.rejects(
        tool.execute({ patchText: '*** Begin Patch\n*** Add File: exists.txt\n+x\n*** End Patch' }),
        /cannot add exists\.txt: file already exists/
    );
    await assert.rejects(tool.execute({ patchText: 'nope' }), /must start with/);
    await assert.rejects(tool.execute({ patchText: '*** Begin Patch\n*** End Patch' }), /empty patch/);
    await assert.rejects(
        tool.execute({ patchText: '*** Begin Patch\n*** Update File: a.txt\nbad line\n*** End Patch' }),
        /must start with '\+', '-', ' ' or '@@'/
    );
    await assert.rejects(tool.execute({}), /patchText is required/);
});

test('patch keeps path confinement for every path in the patch', async (t) => {
    const root = tempRoot(t);
    const tool = patchTool({ root });

    await assert.rejects(
        tool.execute({ patchText: '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch' }),
        /escapes/
    );
    await assert.rejects(
        tool.execute({ patchText: '*** Begin Patch\n*** Delete File: /etc/passwd\n*** End Patch' }),
        /absolute/
    );
});

test('patchTool requires an explicit root', () => {
    assert.throws(() => patchTool(), /root/);
});
