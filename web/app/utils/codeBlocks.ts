// Writing a code block in a text box (ORR-647): the edits a key makes, worked out on the text alone. The plugin
// (plugins/code-blocks.client.ts) applies them to whichever box has the focus.

/** Text to put in place of `from`–`to`, and where the cursor goes after it. */
export interface CodeEdit {
    from: number
    to: number
    insert: string
    cursor: number
}

const FENCE = /^ {0,3}```/
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1
const fences = (lines: string[]) => lines.filter(line => FENCE.test(line)).length

/** ⌘E: a selection on one line in backticks, one over several lines in a code block, and with none an empty code block
 * with the cursor in it. */
export function wrapInCode(text: string, start: number, end: number): CodeEdit {
    const selected = text.slice(start, end)
    if (selected && !selected.includes('\n')) return {from: start, to: end, insert: `\`${selected}\``, cursor: end + 2}
    const before = start > 0 && text[start - 1] !== '\n' ? '\n' : ''
    const open = `${before}\`\`\`\n`
    const insert = `${open}${selected}\n\`\`\``
    return {from: start, to: end, insert, cursor: start + (selected ? insert.length : open.length)}
}

/** Enter at `at`: on the end of a line opening a code block, closes it below with the cursor between; inside one, a new
 * line, so a box where Enter sends doesn't send half a block. Elsewhere, on a closing line among them, nothing. */
export function enterInCode(text: string, at: number): CodeEdit | null {
    const start = lineStart(text, at)
    const before = text.slice(0, start).split('\n').slice(0, -1)
    const inside = fences(before) % 2 === 1
    const lineEnd = text.indexOf('\n', at)
    const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd)
    if (FENCE.test(line)) {
        if (inside || at !== start + line.length) return inside ? null : {from: at, to: at, insert: '\n', cursor: at + 1}
        // One with a closing line of its own already just gets a new line.
        const after = lineEnd === -1 ? [] : text.slice(lineEnd + 1).split('\n')
        const insert = fences(after) % 2 === 1 ? '\n' : '\n\n```'
        return {from: at, to: at, insert, cursor: at + 1}
    }
    return inside ? {from: at, to: at, insert: '\n', cursor: at + 1} : null
}
