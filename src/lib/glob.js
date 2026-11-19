// Glob → RegExp for the subset the tools document: '*', '**' (and '**/' as
// zero-or-more segments), '?', '{a,b}' alternation (one level), '[abc]'
// character classes. Everything else is matched literally.

function translate(pattern) {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') {
                    re += '(?:[^/]+/)*';
                    i += 3;
                } else {
                    re += '.*';
                    i += 2;
                }
            } else {
                re += '[^/]*';
                i += 1;
            }
        } else if (c === '?') {
            re += '[^/]';
            i += 1;
        } else if (c === '{') {
            const end = pattern.indexOf('}', i);
            if (end === -1) {
                re += '\\{';
                i += 1;
            } else {
                const parts = pattern.slice(i + 1, end).split(',').map(translate);
                re += `(?:${parts.join('|')})`;
                i = end + 1;
            }
        } else if (c === '[') {
            const end = pattern.indexOf(']', i + 1);
            if (end === -1) {
                re += '\\[';
                i += 1;
            } else {
                const cls = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
                re += `[${cls}]`;
                i = end + 1;
            }
        } else {
            re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
            i += 1;
        }
    }
    return re;
}

export function globToRegExp(pattern) {
    return new RegExp(`^${translate(pattern)}$`);
}

// A pattern with no '/' also matches bare file names, like ripgrep's --glob:
// '*.ts' matches src/deep/a.ts as well as a.ts.
export function globMatches(pattern, relativePath, separator = '/') {
    const full = globToRegExp(pattern).test(relativePath);
    if (full) {
        return true;
    }
    if (pattern.includes(separator)) {
        return false;
    }
    const base = relativePath.split(separator).pop();
    return globToRegExp(pattern).test(base);
}
