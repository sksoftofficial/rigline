// HTML -> Markdown converter for the webfetch tool, ported from opencode's
// html-markdown.ts (zero-dep rewrite on top of our own tokenizer). Same
// output conventions: ATX headings, [text](href) links with escaping, fenced
// code blocks sized to the content, nested lists with aligned indentation,
// blockquote `> ` prefixes, pipe tables with a plain-text fallback, hidden
// subtrees and closed <details> suppressed. Output is byte-bounded.

import { tokenizeHTML } from './html.js';

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const CONTENT_BYTES = MAX_MARKDOWN_BYTES - 64 * 1024;

const OMITTED = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'meta', 'link', 'template', 'head']);
const BLOCKS = new Set([
    'address', 'article', 'aside', 'details', 'dialog', 'div', 'dl', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'header', 'main', 'nav', 'p',
    'section', 'summary'
]);
const INLINE_MARKERS = { strong: '**', b: '**', em: '*', i: '*', s: '~~', strike: '~~', del: '~~' };
const TEXT_SKIP = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);

const encoder = new TextEncoder();

function sliceBytes(value, bytes) {
    if (encoder.encode(value).byteLength <= bytes) {
        return value;
    }
    const characters = Array.from(value);
    let low = 0;
    let high = characters.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encoder.encode(characters.slice(0, middle).join('')).byteLength <= bytes) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return characters.slice(0, low).join('');
}

function longestRun(value, character) {
    let longest = 0;
    let current = 0;
    for (const item of value) {
        current = item === character ? current + 1 : 0;
        longest = Math.max(longest, current);
    }
    return longest;
}

const escapeText = (value) => value
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/~/g, '\\~')
    .replace(/^([#+-])/, '\\$1')
    .replace(/^(\d+)\./, '$1\\.');

const destination = (value) => value.replace(/([\\()])/g, '\\$1').replace(/[\t\n\r ]+/g, '%20');

const title = (value) => value
    ? ` "${value.replace(/[\t\n\r ]+/g, ' ').trim().replace(/([\\"])/g, '\\$1')}"`
    : '';

export function convertHTMLToMarkdown(html) {
    const out = []; // string chunks, or { raw } for code that must survive normalization
    let bytes = 0;
    const stack = [];
    let pendingSpace = false;
    let pendingIndent = '';
    const pendingMarkers = [];
    let quoteDepth = 0;
    let needsQuotePrefix = false;
    let activeCode;
    let activeLink;
    let linkOpen = false;
    let activeList;
    let activeItem;
    let activeTable;
    let activeCell;
    let tableDepth = 0;
    let activeDetails;

    const append = (value) => {
        if (!value || bytes >= CONTENT_BYTES) {
            return;
        }
        const encoded = encoder.encode(value);
        const remaining = CONTENT_BYTES - bytes;
        if (encoded.byteLength > remaining) {
            value = sliceBytes(value, remaining);
        }
        out.push(value);
        bytes += encoder.encode(value).byteLength;
    };
    const appendRaw = (value) => {
        const before = out.length;
        append(value);
        if (out.length > before) {
            out[out.length - 1] = { raw: out[out.length - 1] };
        }
    };
    const take = (start) => {
        const chunks = out.splice(start);
        const value = chunks.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.raw)).join('');
        bytes -= encoder.encode(value).byteLength;
        return value;
    };

    const prefixQuote = () => {
        if (!needsQuotePrefix || quoteDepth === 0 || activeCell) {
            return;
        }
        append('> '.repeat(Math.min(8, quoteDepth)));
        needsQuotePrefix = false;
    };
    const flushSpace = () => {
        if (!pendingSpace) {
            return;
        }
        pendingSpace = false;
        const last = out.at(-1);
        const tail = typeof last === 'string' ? last.at(-1) : last?.raw.at(-1);
        if (tail && tail !== '\n' && tail !== ' ') {
            append(' ');
        }
    };
    // Emits everything pending before real inline content: whitespace, quote
    // prefix, list indent, the opening '[' of a link, queued emphasis markers.
    const inline = (value) => {
        flushSpace();
        prefixQuote();
        if (pendingIndent) {
            append(pendingIndent);
            pendingIndent = '';
        }
        if (activeLink && !linkOpen) {
            append('[');
            linkOpen = true;
        }
        while (pendingMarkers.length > 0) {
            append(pendingMarkers.shift());
        }
        append(value);
    };
    const inlineRaw = (value) => {
        flushSpace();
        prefixQuote();
        if (activeLink && !linkOpen) {
            append('[');
            linkOpen = true;
        }
        while (pendingMarkers.length > 0) {
            append(pendingMarkers.shift());
        }
        appendRaw(value);
    };
    const block = () => {
        if (activeLink && linkOpen) {
            append(`](${destination(activeLink.href)}${title(activeLink.title)})`);
            activeLink = undefined;
            linkOpen = false;
        }
        pendingSpace = false;
        pendingMarkers.length = 0;
        append('\n\n');
        needsQuotePrefix = quoteDepth > 0;
        pendingIndent = activeItem?.indent ?? '';
    };
    const closeLink = () => {
        if (linkOpen) {
            append(`](${destination(activeLink.href)}${title(activeLink.title)})`);
        }
        activeLink = undefined;
        linkOpen = false;
    };

    const text = (value) => {
        if (activeCode) {
            activeCode.text += value;
            return;
        }
        for (const part of value.split(/([\t\n\f\r ]+)/)) {
            if (!part) {
                continue;
            }
            if (/^[\t\n\f\r ]+$/.test(part)) {
                pendingSpace = true;
                continue;
            }
            inline(escapeText(part));
        }
    };

    const finishCode = (code) => {
        if (code.inline) {
            if (!code.text) {
                return;
            }
            const backticks = longestRun(code.text, '`');
            const fence = '`'.repeat(Math.max(1, backticks + 1));
            const available = Math.max(0, CONTENT_BYTES - bytes - fence.length * 2);
            let payload = sliceBytes(code.text, available);
            while (payload) {
                const padding = /^[ `]|[ `]$/.test(payload) && !/^ +$/.test(payload) ? ' ' : '';
                if (encoder.encode(payload).byteLength + padding.length * 2 <= available) {
                    inlineRaw(`${fence}${padding}${payload}${padding}${fence}`);
                    return;
                }
                payload = sliceBytes(payload, encoder.encode(payload).byteLength - 1);
            }
            return;
        }
        if (activeCell) {
            text(code.text);
            return;
        }
        const backticks = longestRun(code.text, '`');
        const tildes = longestRun(code.text, '~');
        const marker = backticks <= tildes ? '`' : '~';
        const fence = marker.repeat(Math.max(3, (marker === '`' ? backticks : tildes) + 1));
        block();
        let payload = code.text;
        for (;;) {
            const candidate = `${fence}${code.language ?? ''}\n${payload}${payload.endsWith('\n') ? '' : '\n'}${fence}`;
            if (bytes + encoder.encode(candidate).byteLength <= CONTENT_BYTES || !payload) {
                if (payload) {
                    appendRaw(candidate);
                }
                block();
                return;
            }
            const excess = bytes + encoder.encode(candidate).byteLength - CONTENT_BYTES;
            payload = sliceBytes(payload, Math.max(0, encoder.encode(payload).byteLength - Math.ceil(excess)));
        }
    };

    const emitTable = (table) => {
        const loose = take(table.start).replace(/[\t\r\n ]+/g, ' ').trim();
        const width = table.rows[0]?.length ?? 0;
        const rectangular = width > 0 && table.rows.every((row) => row.length === width);
        if (loose) {
            append(loose);
            block();
        }
        if (table.caption) {
            append(table.caption);
            block();
        }
        if (!table.fallback && rectangular) {
            append(`| ${table.rows[0].join(' | ')} |`);
            append(`\n|${' --- |'.repeat(width)}`);
            for (const row of table.rows.slice(1)) {
                append(`\n| ${row.join(' | ')} |`);
            }
        } else {
            table.rows.forEach((row, index) => {
                if (index > 0) {
                    block();
                }
                append(row.join(' | '));
            });
        }
        block();
    };

    const onOpen = (name, attrs) => {
        const parent = stack.at(-1);
        const frame = { name, suppressed: parent?.suppressed === true || OMITTED.has(name) };
        if (!frame.suppressed) {
            const hidden = 'hidden' in attrs || attrs['aria-hidden']?.toLowerCase() === 'true';
            const details = activeDetails;
            if (hidden || (details && !details.open && !details.summary && name !== 'summary')) {
                frame.suppressed = true;
            }
        }
        stack.push(frame);
        if (frame.suppressed) {
            return;
        }

        if (activeCode && !activeCode.inline) {
            if (name === 'br') {
                activeCode.text += '\n';
            }
            if (name === 'code' && attrs.class) {
                activeCode.language = /(?:language-|lang-)([^\s]+)/.exec(attrs.class)?.[1];
            }
            return;
        }
        if (name === 'details') {
            frame.details = { open: 'open' in attrs, summary: false, previous: activeDetails };
            activeDetails = frame.details;
            return block();
        }
        if (name === 'summary') {
            if (activeDetails) {
                activeDetails.summary = true;
            }
            return block();
        }
        if (name === 'pre') {
            block();
            frame.code = { inline: false, text: '', language: undefined };
            activeCode = frame.code;
            return;
        }
        if (name === 'code') {
            if (activeCode) {
                return;
            }
            frame.code = { inline: true, text: '' };
            activeCode = frame.code;
            return;
        }
        if (/^h[1-6]$/.test(name)) {
            block();
            return inline(`${'#'.repeat(Number(name[1]))} `);
        }
        if (BLOCKS.has(name)) {
            return block();
        }
        if (name === 'br') {
            pendingSpace = false;
            inline('  \n');
            needsQuotePrefix = quoteDepth > 0;
            return;
        }
        if (name === 'hr') {
            block();
            inline('---');
            return block();
        }
        const marker = INLINE_MARKERS[name];
        if (marker) {
            flushSpace();
            frame.marker = marker;
            pendingMarkers.push(marker);
            return;
        }
        if (name === 'a') {
            if (activeLink) {
                closeLink();
            }
            frame.link = { href: attrs.href ?? '', title: attrs.title };
            activeLink = frame.link;
            return;
        }
        if (name === 'img') {
            const alt = (attrs.alt ?? '').replace(/([\\\]])/g, '\\$1');
            inline(`![${alt}](${destination(attrs.src ?? '')}${title(attrs.title)})`);
            return;
        }
        if (name === 'blockquote') {
            block();
            quoteDepth += 1;
            needsQuotePrefix = true;
            return;
        }
        if (name === 'ul' || name === 'ol') {
            block();
            const start = Number.parseInt(attrs.start ?? '1', 10);
            frame.list = { ordered: name === 'ol', next: Number.isNaN(start) ? 1 : start, previous: activeList };
            activeList = frame.list;
            return;
        }
        if (name === 'li') {
            block();
            const value = Number.parseInt(attrs.value ?? '', 10);
            if (activeList?.ordered && !Number.isNaN(value)) {
                activeList.next = value;
            }
            const marker = activeList?.ordered ? `${activeList.next++}.` : '-';
            const prefix = `${(activeItem?.indent ?? '').slice(0, 24)}${marker} `;
            frame.item = { indent: ' '.repeat(prefix.length), previous: activeItem };
            activeItem = frame.item;
            pendingIndent = '';
            return inline(prefix);
        }
        if (name === 'table') {
            block();
            tableDepth += 1;
            if (tableDepth === 1) {
                frame.table = { start: out.length, rows: [], row: undefined, caption: undefined, fallback: false, previous: activeTable };
                activeTable = frame.table;
            } else {
                pendingSpace = true;
            }
            return;
        }
        if (name === 'tr') {
            if (tableDepth !== 1) {
                pendingSpace = true;
                return;
            }
            if (activeTable) {
                activeTable.row = [];
            }
            return;
        }
        if (name === 'th' || name === 'td') {
            if (tableDepth !== 1) {
                pendingSpace = true;
                return;
            }
            if (attrs.colspan || attrs.rowspan) {
                activeTable.fallback = true;
            }
            frame.cell = { start: out.length };
            activeCell = frame.cell;
            return;
        }
        if (name === 'caption') {
            frame.caption = { start: out.length };
            return;
        }
        if (name === 'dt') {
            block();
            return inline('**');
        }
        if (name === 'dd') {
            return inline('\n: ');
        }
    };

    const onText = (value) => {
        if (stack.at(-1)?.suppressed) {
            return;
        }
        // Bare text directly inside a collapsed <details> is hidden too —
        // opencode's rule only flags child elements, the text node hole is
        // closed here on purpose.
        if (activeDetails && !activeDetails.open && !activeDetails.summary) {
            return;
        }
        text(value);
    };

    const onClose = (name) => {
        // Close the nearest matching frame, implicitly closing anything opened
        // after it that was never closed — tolerant of malformed documents.
        let index = stack.length - 1;
        while (index >= 0 && stack[index].name !== name) {
            index -= 1;
        }
        if (index === -1) {
            return;
        }
        const [frame] = stack.splice(index);
        if (frame.suppressed) {
            return;
        }
        if (activeCode && !activeCode.inline && !frame.code) {
            return;
        }
        if (frame.code) {
            activeCode = undefined;
            finishCode(frame.code);
            return;
        }
        if (name === 'summary') {
            if (activeDetails) {
                activeDetails.summary = false;
            }
            return block();
        }
        if (name === 'details') {
            activeDetails = frame.details?.previous;
            return block();
        }
        if (frame.marker) {
            const queued = pendingMarkers.lastIndexOf(frame.marker);
            if (queued !== -1) {
                pendingMarkers.splice(queued, 1); // never emitted — the element had no text
            } else {
                inline(frame.marker);
            }
            return;
        }
        if (name === 'dt') {
            return inline('**');
        }
        if (name === 'dd') {
            return block();
        }
        if (name === 'a') {
            if (frame.link && activeLink === frame.link) {
                closeLink();
            }
            return;
        }
        if (/^h[1-6]$/.test(name) || BLOCKS.has(name)) {
            return block();
        }
        if (name === 'blockquote') {
            quoteDepth -= 1;
            return block();
        }
        if (name === 'li') {
            activeItem = frame.item?.previous;
            return block();
        }
        if (name === 'ul' || name === 'ol') {
            activeList = frame.list?.previous;
            return block();
        }
        if ((name === 'th' || name === 'td') && tableDepth === 1) {
            activeCell = undefined;
            if (frame.cell) {
                const value = take(frame.cell.start)
                    .replace(/[\t\r\n ]+/g, ' ')
                    .trim()
                    .replace(/(?<!\\)\|/g, '\\|');
                activeTable?.row?.push(value);
            }
            return;
        }
        if (name === 'tr') {
            if (tableDepth !== 1) {
                return;
            }
            if (activeTable?.row) {
                activeTable.rows.push(activeTable.row);
            }
            if (activeTable) {
                activeTable.row = undefined;
            }
            pendingSpace = true;
            return;
        }
        if (name === 'caption' && frame.caption && activeTable) {
            activeTable.caption = take(frame.caption.start).replace(/[\t\r\n ]+/g, ' ').trim();
            return;
        }
        if (name === 'table') {
            tableDepth -= 1;
            if (tableDepth === 0 && frame.table) {
                activeTable = frame.table.previous;
                emitTable(frame.table);
            } else {
                pendingSpace = true;
            }
            return;
        }
    };

    for (const event of tokenizeHTML(html)) {
        if (event.type === 'open') {
            onOpen(event.name, event.attrs);
        } else if (event.type === 'close') {
            onClose(event.name);
        } else {
            onText(event.value);
        }
    }

    // Normalization pass over plain chunks (code chunks are raw and skipped):
    // keep only intentional two-space hard breaks, collapse blank-line runs.
    const normalized = [];
    let pendingText = '';
    const flushText = () => {
        if (!pendingText) {
            return;
        }
        normalized.push(pendingText
            .replace(/[ \t]+\n/g, (space) => (space.startsWith('  ') ? '  \n' : '\n'))
            .replace(/\n{3,}/g, '\n\n'));
        pendingText = '';
    };
    for (const chunk of out) {
        if (typeof chunk === 'string') {
            pendingText += chunk;
        } else {
            flushText();
            normalized.push(chunk.raw);
        }
    }
    flushText();
    return sliceBytes(normalized.join('').trim(), MAX_MARKDOWN_BYTES);
}

// format: 'text' — strips markup entirely, keeping text outside
// script/style/noscript/iframe/object/embed subtrees. (opencode concatenates
// text nodes and trims; we additionally break lines at block elements so
// glued markup like <p>a</p><p>b</p> does not run together.)
export function extractTextFromHTML(html) {
    let skipDepth = 0;
    let text = '';
    const breakLine = () => {
        if (text && !text.endsWith('\n')) {
            text += '\n';
        }
    };
    for (const event of tokenizeHTML(html)) {
        if (event.type === 'text') {
            if (skipDepth === 0) {
                text += event.value;
            }
        } else if (event.type === 'open') {
            if (TEXT_SKIP.has(event.name)) {
                skipDepth += 1;
            } else if (skipDepth === 0 && BLOCKS.has(event.name)) {
                breakLine();
            }
        } else if (skipDepth > 0 && TEXT_SKIP.has(event.name)) {
            skipDepth -= 1;
        } else if (skipDepth === 0 && BLOCKS.has(event.name)) {
            breakLine();
        }
    }
    return text.trim();
}
