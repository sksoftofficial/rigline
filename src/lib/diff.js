// Minimal unified line diff (LCS) with 3 context lines per hunk — powers the
// edit tool's preview without a dependency. Lines carry their trailing
// newline so a missing final newline is representable.

const CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

// Fall back to whole-file replace semantics when the LCS table would be
// enormous (very large, very different inputs); sandbox-scale files never
// hit this.
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text) {
    if (text === '') {
        return [];
    }
    return text.split(/(?<=\n)/);
}

function diffOps(a, b) {
    const ops = [];
    if (a.length * b.length > MAX_LCS_CELLS) {
        for (const line of a) {
            ops.push({ type: '-', text: line });
        }
        for (const line of b) {
            ops.push({ type: '+', text: line });
        }
        return ops;
    }
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            table[i * width + j] = a[i] === b[j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            ops.push({ type: '=', text: a[i] });
            i += 1;
            j += 1;
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            ops.push({ type: '-', text: a[i] });
            i += 1;
        } else {
            ops.push({ type: '+', text: b[j] });
            j += 1;
        }
    }
    while (i < a.length) {
        ops.push({ type: '-', text: a[i] });
        i += 1;
    }
    while (j < b.length) {
        ops.push({ type: '+', text: b[j] });
        j += 1;
    }
    return ops;
}

function emitLine(out, prefix, text) {
    if (text.endsWith('\n')) {
        out.push(prefix + text);
    } else {
        out.push(`${prefix + text}\n${NO_NEWLINE_MARKER}\n`);
    }
}

function countRef(count) {
    return count === 1 ? '' : `,${count}`;
}

export function unifiedDiff(before, after, { maxLines = 200 } = {}) {
    if (before === after) {
        return '';
    }
    const ops = diffOps(splitLines(before), splitLines(after));

    // Runs of non-context ops, pre-merged when separated by <= 2*CONTEXT
    // equals so their context windows become one hunk (GNU diff behavior).
    const groups = [];
    let k = 0;
    while (k < ops.length) {
        if (ops[k].type === '=') {
            k += 1;
            continue;
        }
        const start = k;
        while (k < ops.length && ops[k].type !== '=') {
            k += 1;
        }
        const last = groups[groups.length - 1];
        if (last && start - last[1] <= 2 * CONTEXT_LINES) {
            last[1] = k;
        } else {
            groups.push([start, k]);
        }
    }

    const out = [];
    let aLine = 1;
    let bLine = 1;
    let covered = 0;
    for (const [runStart, runEnd] of groups) {
        const hunkStart = Math.max(0, runStart - CONTEXT_LINES);
        const hunkEnd = Math.min(ops.length, runEnd + CONTEXT_LINES);
        // Skip ops before the hunk when advancing line counters.
        for (let s = covered; s < hunkStart; s += 1) {
            if (ops[s].type !== '+') {
                aLine += 1;
            }
            if (ops[s].type !== '-') {
                bLine += 1;
            }
        }
        let aCount = 0;
        let bCount = 0;
        for (let s = hunkStart; s < hunkEnd; s += 1) {
            if (ops[s].type !== '+') {
                aCount += 1;
            }
            if (ops[s].type !== '-') {
                bCount += 1;
            }
        }
        out.push(`@@ -${aLine}${countRef(aCount)} +${bLine}${countRef(bCount)} @@\n`);
        for (let s = hunkStart; s < hunkEnd; s += 1) {
            emitLine(out, ops[s].type === '=' ? ' ' : ops[s].type, ops[s].text);
        }
        covered = hunkEnd;
    }
    let text = out.join('');
    const lines = text.split('\n');
    if (lines.length - 1 > maxLines) {
        text = `${lines.slice(0, maxLines).join('\n')}\n... (diff truncated)`;
    }
    return text;
}
