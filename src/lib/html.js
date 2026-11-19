// Minimal HTML tokenizer for the webfetch tool — a zero-dependency stand-in
// for the htmlparser2-based parsing opencode uses. Emits a flat event list:
//   { type: 'open', name, attrs, selfClosing }
//   { type: 'close', name }
//   { type: 'text', value }   (named/numeric entities decoded)
// Tolerant like real HTML parsing: comments, doctype, CDATA, raw-text
// elements (script/style/title/textarea/...), unquoted attributes,
// mismatched tags, unclosed everything. Tag and attribute names are
// lowercased; first duplicate attribute wins (per spec).

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

const NAME_PATTERN = /[a-zA-Z][a-zA-Z0-9:._-]*/y;
const ATTRIBUTE_NAME_PATTERN = /[^\s"'>/=]+/y;
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+;|#\d+;|[a-zA-Z][a-zA-Z0-9]*;)/g;

// Practical subset of the full HTML named-entity table: punctuation, quotes,
// dashes, math and currency signs, Latin-1 accented letters — everything
// else stays literal. Entities without a trailing semicolon stay literal too
// (a deliberate deviation from the browser's legacy-entity handling).
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    iexcl: '\u00a1', cent: '\u00a2', pound: '\u00a3', curren: '\u00a4', yen: '\u00a5', brvbar: '\u00a6',
    sect: '\u00a7', uml: '\u00a8', copy: '\u00a9', ordf: '\u00aa', laquo: '\u00ab', not: '\u00ac',
    shy: '\u00ad', reg: '\u00ae', macr: '\u00af', deg: '\u00b0', plusmn: '\u00b1', sup2: '\u00b2',
    sup3: '\u00b3', acute: '\u00b4', micro: '\u00b5', para: '\u00b6', middot: '\u00b7', cedil: '\u00b8',
    sup1: '\u00b9', ordm: '\u00ba', raquo: '\u00bb', frac14: '\u00bc', frac12: '\u00bd', frac34: '\u00be',
    iquest: '\u00bf', times: '\u00d7', divide: '\u00f7', ndash: '\u2013', mdash: '\u2014',
    lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
    dagger: '\u2020', Dagger: '\u2021', bull: '\u2022', hellip: '\u2026', permil: '\u2030',
    prime: '\u2032', Prime: '\u2033', lsaquo: '\u2039', rsaquo: '\u203a', euro: '\u20ac',
    trade: '\u2122', larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194',
    minus: '\u2212', lowast: '\u2217', radic: '\u221a', prop: '\u221d', infin: '\u221e',
    ang: '\u2220', and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a', int: '\u222b',
    there4: '\u2234', sim: '\u223c', cong: '\u2245', asymp: '\u2248', ne: '\u2260', equiv: '\u2261',
    le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283', nsub: '\u2284', sube: '\u2286',
    supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22a5', sdot: '\u22c5',
    newline: '\n', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwj: '\u200d', zwnj: '\u200c',
    Agrave: '\u00c0', Aacute: '\u00c1', Acirc: '\u00c2', Atilde: '\u00c3', Auml: '\u00c4', Aring: '\u00c5',
    AElig: '\u00c6', Ccedil: '\u00c7', Egrave: '\u00c8', Eacute: '\u00c9', Ecirc: '\u00ca', Euml: '\u00cb',
    Igrave: '\u00cc', Iacute: '\u00cd', Icirc: '\u00ce', Iuml: '\u00cf', ETH: '\u00d0', Ntilde: '\u00d1',
    Ograve: '\u00d2', Oacute: '\u00d3', Ocirc: '\u00d4', Otilde: '\u00d5', Ouml: '\u00d6', Oslash: '\u00d8',
    Ugrave: '\u00d9', Uacute: '\u00da', Ucirc: '\u00db', Uuml: '\u00dc', Yacute: '\u00dd', THORN: '\u00de',
    szlig: '\u00df', agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4',
    aring: '\u00e5', aelig: '\u00e6', ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea',
    euml: '\u00eb', igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef', eth: '\u00f0',
    ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6',
    oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd',
    thorn: '\u00fe', yuml: '\u00ff'
};

export function decodeEntities(value) {
    if (!value.includes('&')) {
        return value;
    }
    return value.replace(ENTITY_PATTERN, (match, body) => {
        const reference = body.slice(0, -1); // strip the ';'
        if (reference[0] === '#') {
            const code = reference[1] === 'x' || reference[1] === 'X'
                ? Number.parseInt(reference.slice(2), 16)
                : Number.parseInt(reference.slice(1), 10);
            if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
                return '\ufffd';
            }
            return String.fromCodePoint(code);
        }
        return NAMED_ENTITIES[reference] ?? NAMED_ENTITIES[reference.toLowerCase()] ?? match;
    });
}

const isWhitespace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;

function parseAttributes(html, start) {
    const attrs = {};
    let selfClosing = false;
    let i = start;
    const length = html.length;

    for (;;) {
        while (i < length && isWhitespace(html.charCodeAt(i))) {
            i += 1;
        }
        if (i >= length) {
            return { attrs, selfClosing, next: i };
        }
        const ch = html[i];
        if (ch === '>') {
            return { attrs, selfClosing, next: i + 1 };
        }
        if (ch === '/') {
            if (html[i + 1] === '>') {
                return { attrs, selfClosing: true, next: i + 2 };
            }
            i += 1; // stray slash inside the tag — treated as a separator
            continue;
        }
        ATTRIBUTE_NAME_PATTERN.lastIndex = i;
        const nameMatch = ATTRIBUTE_NAME_PATTERN.exec(html);
        if (!nameMatch) {
            i += 1; // e.g. '=' at attribute-name position — dropped per spec
            continue;
        }
        i = ATTRIBUTE_NAME_PATTERN.lastIndex;
        const name = nameMatch[0].toLowerCase();

        let j = i;
        while (j < length && isWhitespace(html.charCodeAt(j))) {
            j += 1;
        }
        let value = '';
        if (html[j] === '=') {
            j += 1;
            while (j < length && isWhitespace(html.charCodeAt(j))) {
                j += 1;
            }
            const quote = html[j];
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, j + 1);
                value = html.slice(j + 1, close === -1 ? length : close);
                j = close === -1 ? length : close + 1;
            } else {
                const valueStart = j;
                while (j < length && !isWhitespace(html.charCodeAt(j)) && html[j] !== '>') {
                    j += 1;
                }
                value = html.slice(valueStart, j);
            }
            i = j;
        }
        if (!(name in attrs)) {
            attrs[name] = decodeEntities(value);
        }
    }
}

// Finds where a raw-text element (script/style/...) ends: only `</name`
// followed by whitespace, '/', or '>' closes it — `</scriptx` does not.
function findRawTextEnd(html, from, name) {
    const pattern = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
    pattern.lastIndex = from;
    const match = pattern.exec(html);
    if (match === null) {
        return { contentEnd: html.length, next: html.length };
    }
    const gt = html.indexOf('>', match.index + match[0].length);
    return { contentEnd: match.index, next: gt === -1 ? html.length : gt + 1 };
}

export function tokenizeHTML(html) {
    const events = [];
    const length = html.length;
    let i = 0;

    const pushText = (value, decode = true) => {
        if (value) {
            events.push({ type: 'text', value: decode ? decodeEntities(value) : value });
        }
    };

    while (i < length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) {
            pushText(html.slice(i));
            break;
        }
        if (lt > i) {
            pushText(html.slice(i, lt));
        }

        if (html.startsWith('<!--', lt)) {
            const end = html.indexOf('-->', lt + 4);
            i = end === -1 ? length : end + 3;
            continue;
        }
        if (html.startsWith('<![CDATA[', lt)) {
            const end = html.indexOf(']]>', lt + 9);
            pushText(html.slice(lt + 9, end === -1 ? length : end), false);
            i = end === -1 ? length : end + 3;
            continue;
        }
        if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
            const end = html.indexOf('>', lt + 2);
            i = end === -1 ? length : end + 1;
            continue;
        }
        if (html.startsWith('</', lt)) {
            NAME_PATTERN.lastIndex = lt + 2;
            const name = NAME_PATTERN.exec(html)?.[0]?.toLowerCase();
            const end = html.indexOf('>', lt + 2);
            const next = end === -1 ? length : end + 1;
            if (name !== undefined) {
                events.push({ type: 'close', name });
            }
            i = next;
            continue;
        }

        NAME_PATTERN.lastIndex = lt + 1;
        const name = NAME_PATTERN.exec(html)?.[0]?.toLowerCase();
        if (name === undefined) {
            pushText('<', false); // a lone '<' that does not open a tag is text
            i = lt + 1;
            continue;
        }
        const { attrs, selfClosing, next } = parseAttributes(html, NAME_PATTERN.lastIndex);
        i = next;
        events.push({ type: 'open', name, attrs, selfClosing });

        if (RAW_TEXT_ELEMENTS.has(name)) {
            const { contentEnd, next: afterContent } = findRawTextEnd(html, i, name);
            pushText(html.slice(i, contentEnd), name !== 'script' && name !== 'style');
            i = afterContent;
            events.push({ type: 'close', name });
        }
    }

    return events;
}
