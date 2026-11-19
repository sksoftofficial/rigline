import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeHTML, decodeEntities } from '../src/lib/html.js';
import { convertHTMLToMarkdown, extractTextFromHTML } from '../src/lib/html-to-markdown.js';

test('tokenizer parses tags, attributes, and raw-text elements', () => {
    const events = tokenizeHTML('<a href=\'single\' data-x=bare :colon=1 dup="first" dup="second">t</a>'
        + '<script>x = "</scriptx>"; if (a<b) {}</script>after');

    assert.deepEqual(events[0], { type: 'open', name: 'a', selfClosing: false, attrs: {
        href: 'single', 'data-x': 'bare', ':colon': '1', dup: 'first'
    } });
    assert.deepEqual(events[1], { type: 'text', value: 't' });
    assert.deepEqual(events[2], { type: 'close', name: 'a' });
    assert.deepEqual(events[3], { type: 'open', name: 'script', selfClosing: false, attrs: {} });
    assert.deepEqual(events[4], { type: 'text', value: 'x = "</scriptx>"; if (a<b) {}' });
    assert.deepEqual(events[5], { type: 'close', name: 'script' });
    assert.deepEqual(events[6], { type: 'text', value: 'after' });
});

test('tokenizer tolerates comments, doctype, CDATA, self-closing and stray markup', () => {
    const events = tokenizeHTML('<!DOCTYPE html><!-- c --><br/><p>a &amp; b</p><![CDATA[x<y]]> 1 < 2');
    assert.equal(events[0].type, 'open');
    assert.equal(events[0].name, 'br');
    assert.equal(events[0].selfClosing, true);
    assert.deepEqual(events[1], { type: 'open', name: 'p', selfClosing: false, attrs: {} });
    assert.deepEqual(events[2], { type: 'text', value: 'a & b' });
    assert.deepEqual(events[3], { type: 'close', name: 'p' });
    assert.deepEqual(events[4], { type: 'text', value: 'x<y' });
    assert.ok(events.slice(5).every((event) => event.type === 'text'));
});

test('decodeEntities handles named, numeric, hex and unknown references', () => {
    assert.equal(decodeEntities('a&amp;b'), 'a&b');
    assert.equal(decodeEntities('&#65;&#x42;&#X43;'), 'ABC');
    assert.equal(decodeEntities('&eacute;&nbsp;&mdash;'), 'é\u00a0—');
    assert.equal(decodeEntities('&nosuch; & amp'), '&nosuch; & amp');
    assert.equal(decodeEntities('&#0;&#xD800;'), '\ufffd\ufffd');
});

test('convertHTMLToMarkdown: headings, emphasis, links, head suppressed', () => {
    const html = '<html><head><title>T</title><meta charset="utf-8"></head>'
        + '<body><h1>Hello</h1><p>Some <b>bold</b> text with a <a href="https://x.com/a?b=1">link</a>.</p></body></html>';

    assert.equal(
        convertHTMLToMarkdown(html),
        '# Hello\n\nSome **bold** text with a [link](https://x.com/a?b=1).'
    );
});

test('convertHTMLToMarkdown: fenced code blocks pick a fence the content cannot break', () => {
    assert.equal(
        convertHTMLToMarkdown('<pre><code class="language-js">const x = 1;\nconsole.log(`x`);</code></pre>'),
        '~~~js\nconst x = 1;\nconsole.log(`x`);\n~~~'
    );
    assert.equal(
        convertHTMLToMarkdown('<p>use <code>a `b` c</code> now</p>'),
        'use ``a `b` c`` now'
    );
    assert.equal(convertHTMLToMarkdown('<p>a<code> x </code>b</p>'), 'a`  x  `b');
});

test('convertHTMLToMarkdown: nested and ordered lists with aligned indentation', () => {
    assert.equal(
        convertHTMLToMarkdown('<ul><li>one</li><li>two<ol start="3"><li>three</li></ol></li></ul>'),
        '- one\n\n- two\n\n  3. three'
    );
});

test('convertHTMLToMarkdown: blockquotes prefix every paragraph', () => {
    assert.equal(
        convertHTMLToMarkdown('<blockquote><p>quoted text</p><p>more</p></blockquote>'),
        '> quoted text\n\n> more'
    );
});

test('convertHTMLToMarkdown: tables become pipe tables with caption', () => {
    assert.equal(
        convertHTMLToMarkdown('<table><caption>Sizes</caption><tr><th>Name</th><th>Size</th></tr><tr><td>a</td><td>1</td></tr></table>'),
        'Sizes\n\n| Name | Size |\n| --- | --- |\n| a | 1 |'
    );
    // colspan forces the plain-text fallback, as does a ragged table
    assert.equal(
        convertHTMLToMarkdown('<table><tr><td colspan="2">wide</td></tr></table>'),
        'wide'
    );
    assert.equal(
        convertHTMLToMarkdown('<table><tr><td>a</td></tr><tr><td>b</td><td>c</td></tr></table>'),
        'a\n\nb | c'
    );
});

test('convertHTMLToMarkdown: entities, hidden subtrees, markdown escaping', () => {
    const html = '<div><span hidden>secret</span><span aria-hidden="true">ghost</span>'
        + '<p>&amp; &lt;tags&gt; caf&eacute; &#39;q&#39;</p></div>';

    assert.equal(convertHTMLToMarkdown(html), '& \\<tags\\> café \'q\'');
    assert.equal(convertHTMLToMarkdown('<p>a < b</p>'), 'a \\< b');
});

test('convertHTMLToMarkdown: closed details show only the summary, open ones show all', () => {
    const html = '<details><summary>Click</summary>hidden body</details>'
        + '<details open><summary>Open</summary>shown body</details>';

    assert.equal(convertHTMLToMarkdown(html), 'Click\n\nOpen\n\nshown body');
});

test('convertHTMLToMarkdown: br, hr, img, definition lists', () => {
    assert.equal(
        convertHTMLToMarkdown('<p>line one<br>line two</p><hr><p><img src="/x.png" alt="A picture"></p>'),
        'line one  \nline two\n\n---\n\n![A picture](/x.png)'
    );
    assert.equal(
        convertHTMLToMarkdown('<dl><dt>term</dt><dd>def</dd></dl>'),
        '**term**\n: def'
    );
});

test('convertHTMLToMarkdown survives unclosed and mismatched tags', () => {
    assert.equal(convertHTMLToMarkdown('<div><p>a<b>b</div>c'), 'a**b\n\nc');
    // empty emphasis is dropped entirely
    assert.equal(convertHTMLToMarkdown('<p>x<b></b>y</p>'), 'xy');
    // script/style content never leaks
    assert.equal(
        convertHTMLToMarkdown('<script>if (a < b) { s = "</div>" }</script><style>p { color: red }</style><p>ok</p>'),
        'ok'
    );
});

test('extractTextFromHTML strips markup and skipped subtrees, breaks blocks', () => {
    const html = '<html><head><title>T</title></head><body><script>bad()</script>'
        + '<p>Hello <b>world</b></p><p>Second</p></body></html>';

    assert.equal(extractTextFromHTML(html), 'T\nHello world\nSecond');
});
