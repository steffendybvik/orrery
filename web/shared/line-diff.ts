// A line-by-line diff of two texts, for showing what a chat's request to change a doc would change (ORR-661).

export interface DiffLine {
    kind: 'same' | 'added' | 'removed'
    text: string
}

/** A run of unchanged lines left out of what's shown. */
export interface DiffSkip {
    kind: 'skipped'
    count: number
}

/** Past this many line pairs, the part that differs is shown as all removed and all added: still true, and quick. */
const COMPARE_AT_MOST = 4_000_000

const linesOf = (text: string) => text === '' ? [] : text.split('\n')

/** Every line of `from` and `to`, in order, each kept, removed or added. */
export function lineDiff(from: string, to: string): DiffLine[] {
    const a = linesOf(from)
    const b = linesOf(to)
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let end = 0
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    const same = (lines: string[]) => lines.map(text => ({kind: 'same' as const, text}))
    const oldLines = a.slice(start, a.length - end)
    const newLines = b.slice(start, b.length - end)
    return [...same(a.slice(0, start)), ...middle(oldLines, newLines), ...same(a.slice(a.length - end))]
}

/** The longest common run of lines, kept; the rest removed or added. */
function middle(a: string[], b: string[]): DiffLine[] {
    const removed = (text: string) => ({kind: 'removed' as const, text})
    const added = (text: string) => ({kind: 'added' as const, text})
    if (!a.length || !b.length || a.length * b.length > COMPARE_AT_MOST) return [...a.map(removed), ...b.map(added)]
    const width = b.length + 1
    const longest = new Uint32Array((a.length + 1) * width)
    const run = (i: number, j: number) => longest[i * width + j] ?? 0
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) longest[i * width + j] = a[i] === b[j] ? run(i + 1, j + 1) + 1 : Math.max(run(i + 1, j), run(i, j + 1))
    }
    const lines: DiffLine[] = []
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            lines.push({kind: 'same', text: a[i] ?? ''})
            i++
            j++
        } else if (run(i + 1, j) >= run(i, j + 1)) lines.push(removed(a[i++] ?? ''))
        else lines.push(added(b[j++] ?? ''))
    }
    return [...lines, ...a.slice(i).map(removed), ...b.slice(j).map(added)]
}

/** The changed lines with `context` unchanged ones around each, and the unchanged runs between them counted. */
export function diffHunks(lines: DiffLine[], context = 2): (DiffLine | DiffSkip)[] {
    const shown = new Set<number>()
    lines.forEach((line, at) => {
        if (line.kind === 'same') return
        for (let near = Math.max(0, at - context); near <= Math.min(lines.length - 1, at + context); near++) shown.add(near)
    })
    const hunks: (DiffLine | DiffSkip)[] = []
    let skipped = 0
    lines.forEach((line, at) => {
        if (!shown.has(at)) {
            skipped++
            return
        }
        if (skipped) hunks.push({kind: 'skipped', count: skipped})
        skipped = 0
        hunks.push(line)
    })
    if (skipped) hunks.push({kind: 'skipped', count: skipped})
    return hunks
}
