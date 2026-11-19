import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { globTool, grepTool } from '../src/tools/index.js';
import { tempRoot, put } from './helpers.js';

function seed(root) {
    put(root, 'a.ts', 'export const one = 1;\n');
    put(root, 'b.md', '# Title\n');
    put(root, join('src', 'deep', 'c.ts'), 'export const two = 2;\nexport const three = 3;\n');
    put(root, join('src', 'notes.md'), 'notes here\n');
    put(root, '.hidden.ts', 'secret\n');
    mkdirSync(join(root, '.hiddendir'), { recursive: true });
    put(root, join('.hiddendir', 'h.ts'), 'x\n');
}

test('glob matches ** patterns across depths, sorted, relative to root', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = globTool({ root });

    assert.equal(
        await tool.execute({ pattern: '**/*.ts' }),
        ['a.ts', 'src/deep/c.ts'].join('\n')
    );
});

test('glob: a pattern with no slash matches basenames at any depth', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = globTool({ root });

    const out = await tool.execute({ pattern: '*.md' });
    assert.ok(out.includes('b.md'));
    assert.ok(out.includes('src/notes.md'));
});

test('glob supports brace alternation and ? and character classes', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = globTool({ root });

    const braces = await tool.execute({ pattern: '**/*.{ts,md}' });
    assert.ok(braces.includes('a.ts'));
    assert.ok(braces.includes('src/notes.md'));

    assert.equal(await tool.execute({ pattern: '?.ts' }), ['a.ts', 'src/deep/c.ts'].join('\n'));
    assert.equal(await tool.execute({ pattern: '[ab].*' }), ['a.ts', 'b.md'].join('\n'));
});

test('glob skips hidden entries unless hidden is true', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = globTool({ root });

    const plain = await tool.execute({ pattern: '**/*.ts' });
    assert.ok(!plain.includes('.hidden.ts'));
    const hidden = await tool.execute({ pattern: '**/*.ts', hidden: true });
    assert.ok(hidden.includes('.hidden.ts'));
    assert.ok(hidden.includes('.hiddendir/h.ts'));
});

test('glob scopes to path, truncates at limit with the teaching footer', async (t) => {
    const root = tempRoot(t);
    seed(root);
    put(root, 'd.md', 'x\n');
    put(root, 'e.md', 'x\n');
    const tool = globTool({ root });

    assert.equal(
        await tool.execute({ pattern: '*.md', path: 'src' }),
        'src/notes.md'
    );

    const limited = await tool.execute({ pattern: '*.md', limit: 1 });
    assert.match(limited, /^b\.md$/m);
    assert.match(limited, /\(Results are truncated: showing first 1 results\./);
});

test('glob reports no files found and validates inputs', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = globTool({ root });

    assert.equal(await tool.execute({ pattern: '**/*.zzz' }), 'No files found');
    await assert.rejects(tool.execute({ pattern: '' }), /pattern must be a non-empty string/);
    await assert.rejects(tool.execute({ pattern: '*', path: 'missing' }), /Directory not found: missing/);
    await assert.rejects(tool.execute({ pattern: '*', path: '../x' }), /escapes/);
    await assert.rejects(tool.execute({ pattern: '*', limit: 0 }), /Limit must be a positive integer/);
});

test('glob never follows symlinked directories out of the root', async (t) => {
    const root = tempRoot(t);
    const outside = tempRoot(t);
    put(outside, 'leak.ts', 'x\n');
    seed(root);
    symlinkSync(outside, join(root, 'linked-dir'));
    const tool = globTool({ root });

    const out = await tool.execute({ pattern: '**/*.ts' });
    assert.ok(!out.includes('leak.ts'), `symlinked dir must not be walked: ${out}`);
});

test('grep groups matches by file with line numbers', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = grepTool({ root });

    assert.equal(
        await tool.execute({ pattern: 'export const' }),
        [
            'Found 3 matches',
            'a.ts:',
            '  Line 1: export const one = 1;',
            '',
            'src/deep/c.ts:',
            '  Line 1: export const two = 2;',
            '  Line 2: export const three = 3;'
        ].join('\n')
    );
});

test('grep: case-insensitive, literal, and include filters', async (t) => {
    const root = tempRoot(t);
    put(root, 'one.ts', 'Hello\n');
    put(root, 'two.txt', 'hello\nHELLO\n');
    const tool = grepTool({ root });

    const insensitive = await tool.execute({ pattern: 'hello', caseSensitive: false });
    assert.equal(insensitive.split('\n')[0], 'Found 3 matches');

    const literal = await tool.execute({ pattern: '(', literal: true });
    assert.equal(literal, 'No matches found');

    const included = await tool.execute({ pattern: 'hello', caseSensitive: false, include: '*.txt' });
    assert.ok(included.includes('two.txt:'));
    assert.ok(!included.includes('one.ts:'));
});

test('grep searches a single file target and reports no matches', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = grepTool({ root });

    const single = await tool.execute({ pattern: 'three', path: 'src/deep/c.ts' });
    assert.ok(single.includes('src/deep/c.ts:'));
    assert.ok(single.includes('  Line 2: export const three = 3;'));

    assert.equal(await tool.execute({ pattern: 'nothing-matches-this' }), 'No matches found');
});

test('grep validates pattern, path, and limit', async (t) => {
    const root = tempRoot(t);
    seed(root);
    const tool = grepTool({ root });

    await assert.rejects(tool.execute({ pattern: '(' }), /Invalid regex pattern/);
    await assert.rejects(tool.execute({ pattern: '' }), /pattern must be a non-empty string/);
    await assert.rejects(tool.execute({ pattern: 'x', path: 'missing.ts' }), /Path not found: missing\.ts/);
    await assert.rejects(tool.execute({ pattern: 'x', path: '/etc' }), /absolute/);
    await assert.rejects(tool.execute({ pattern: 'x', limit: -1 }), /Limit must be a positive integer/);
});

test('grep truncates at limit with the teaching footer and skips binary and hidden files', async (t) => {
    const root = tempRoot(t);
    put(root, 'a.txt', 'hit\nhit\nhit\n');
    put(root, 'bin.dat', Buffer.from([0x68, 0x69, 0x74, 0x00])); // 'hit' + NUL
    const tool = grepTool({ root });

    const limited = await tool.execute({ pattern: 'hit', limit: 2 });
    assert.ok(limited.includes('Found 2 matches'));
    assert.match(limited, /\(Results are truncated: showing first 2 results\./);
    assert.ok(!limited.includes('bin.dat'), 'binary files must be skipped');
});

test('both search tools require an explicit root', () => {
    assert.throws(() => globTool(), /root/);
    assert.throws(() => grepTool({ root: ' ' }), /root/);
});
