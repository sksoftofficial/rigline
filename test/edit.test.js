import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { editTool } from '../src/tools/index.js';
import { tempRoot, put } from './helpers.js';

test('edit replaces a unique exact match and returns a unified diff preview', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'hello world\nsecond line\n');
    const tool = editTool();

    const out = await tool.execute({ path: 'a.txt', oldString: 'world', newString: 'planet' }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'hello planet\nsecond line\n');
    assert.match(out, /^Edited a\.txt \(1 replacement\)/);
    assert.match(out, /@@ -1,2 \+1,2 @@/);
    assert.match(out, /-hello world/);
    assert.match(out, /\+hello planet/);
    assert.match(out, / second line/);
});

test('edit matches multi-line oldString across lines', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'one\ntwo\nthree\n');
    const tool = editTool();

    await tool.execute({ path: 'a.txt', oldString: 'two\nthree', newString: 'TWO\nTHREE' }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'one\nTWO\nTHREE\n');
});

test('edit refuses ambiguous matches without replaceAll, applies all with it', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'x = 1\ny = x\nz = x\n');
    const tool = editTool();

    await assert.rejects(
        tool.execute({ path: 'a.txt', oldString: 'x', newString: 'w' }, { workspaceDir: root }),
        /Found 3 matches for oldString, but expected exactly one/
    );

    const out = await tool.execute({ path: 'a.txt', oldString: 'x', newString: 'w', replaceAll: true }, { workspaceDir: root });
    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'w = 1\ny = w\nz = w\n');
    assert.match(out, /\(3 replacements\)/);
});

test('edit retries with typographic normalization: smart quotes and dashes', async (t) => {
    const root = tempRoot(t);
    put(root, 'prose.txt', 'it\u2019s a \u201Cquoted\u201D thing \u2014 really\n');
    const tool = editTool();

    await tool.execute({
        path: 'prose.txt',
        oldString: "it's a \"quoted\" thing - really",
        newString: 'normalized now'
    }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/prose.txt`, 'utf8'), 'normalized now\n');
});

test('edit retries tolerating trailing whitespace per line', async (t) => {
    const root = tempRoot(t);
    put(root, 'ws.txt', 'first   \nsecond\t\nthird\n');
    const tool = editTool();

    await tool.execute({ path: 'ws.txt', oldString: 'first\nsecond', newString: '1st\n2nd' }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/ws.txt`, 'utf8'), '1st\n2nd\nthird\n');
});

test('edit preserves CRLF endings in untouched lines and reuses them for new lines', async (t) => {
    const root = tempRoot(t);
    put(root, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    const tool = editTool();

    await tool.execute({ path: 'crlf.txt', oldString: 'two', newString: '2\n2b' }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/crlf.txt`, 'utf8'), 'one\r\n2\r\n2b\r\nthree\r\n');
});

test('edit converts line endings when oldString and newString differ only in \\r', async (t) => {
    const root = tempRoot(t);
    put(root, 'lf.txt', 'a\nb\n');
    const tool = editTool();

    await tool.execute({ path: 'lf.txt', oldString: 'a\nb\n', newString: 'a\r\nb\r\n' }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/lf.txt`, 'utf8'), 'a\r\nb\r\n');
});

test('edit miss on a read-output line prefix fails cleanly; nothing is written', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'alpha\nbeta\n');
    const tool = editTool();

    // The model pasted the read tool's `1: ` prefix into oldString — the
    // prefix is not file content, so no tier can match.
    await assert.rejects(
        tool.execute({ path: 'a.txt', oldString: '1: alpha', newString: 'changed' }, { workspaceDir: root }),
        /Could not find oldString in a\.txt\. It must match exactly/
    );
    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'alpha\nbeta\n');
});

test('edit miss teaches: closest lines, numbered like read output, when whitespace is off', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'if (x) {\n    return 1;\n}\n');
    const tool = editTool();

    // The model got the indentation wrong; every line still matches
    // ignoring whitespace, so the hint can point at the right place.
    await assert.rejects(
        tool.execute({ path: 'a.txt', oldString: 'if (x) {\n\treturn 1;\n}', newString: 'if (y) {\n\treturn 1;\n}' }, { workspaceDir: root }),
        (err) => {
            assert.match(err.message, /Could not find oldString in a\.txt/);
            assert.match(err.message, /The closest lines in the file:\n1: if \(x\) \{\n2: +return 1;\n3: \}/);
            return true;
        }
    );
});

test('edit miss teaches: newString already present means the edit likely applied', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'the new content line\n');
    const tool = editTool();

    await assert.rejects(
        tool.execute({ path: 'a.txt', oldString: 'old content line', newString: 'the new content line' }, { workspaceDir: root }),
        /newString is already in the file, so this edit may already be applied/
    );
});

test('edit validates inputs and targets', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'x\n');
    const tool = editTool();

    await assert.rejects(tool.execute({ path: 'a.txt', oldString: 'x', newString: 'x' }, { workspaceDir: root }), /identical/);
    await assert.rejects(tool.execute({ path: 'a.txt', oldString: '', newString: 'y' }, { workspaceDir: root }), /must not be empty/);
    await assert.rejects(tool.execute({ path: 'missing.txt', oldString: 'a', newString: 'b' }, { workspaceDir: root }), /File not found: missing\.txt/);
    await assert.rejects(tool.execute({ path: '/', oldString: 'a', newString: 'b' }, { workspaceDir: root }), /absolute/);
    await assert.rejects(tool.execute({ path: '../x', oldString: 'a', newString: 'b' }, { workspaceDir: root }), /escapes/);
});

test('edit keeps path confinement: symlink escapes rejected', async (t) => {
    const root = tempRoot(t);
    const outside = tempRoot(t);
    put(outside, 'secret.txt', 'top secret');
    put(root, 'a.txt', 'x\n');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(`${outside}/secret.txt`, `${root}/link.txt`);
    const tool = editTool();

    await assert.rejects(
        tool.execute({ path: 'link.txt', oldString: 'top', newString: 'nope' }, { workspaceDir: root }),
        /symlink/
    );
});

test('edit diff marks a missing final newline', async (t) => {
    const root = tempRoot(t);
    put(root, 'nonl.txt', 'only line');
    const tool = editTool();

    const out = await tool.execute({ path: 'nonl.txt', oldString: 'only line', newString: 'only line edited' }, { workspaceDir: root });

    assert.equal(readFileSync(`${root}/nonl.txt`, 'utf8'), 'only line edited');
    assert.match(out, /-only line\n\\ No newline at end of file/);
    assert.match(out, /\+only line edited\n\\ No newline at end of file/);
});

test('editTool without an active session workspace context fails with a teaching error', async () => {
    await assert.rejects(editTool().execute({ path: 'a.txt' }), /requires an active agent session workspace/);
    await assert.rejects(editTool().execute({ path: 'a.txt' }, {}), /requires an active agent session workspace/);
});
