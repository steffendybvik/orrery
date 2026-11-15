// Writing Markdown in a text box (ORR-932): the edits a toolbar button or a key makes, worked out on the text alone, and
// the source drawn with its formatting showing, behind the box (MarkdownField). The stored value stays plain Markdown.
import type {CodeEdit} from '~/utils/codeBlocks'

/** Inline formatting a selection can be wrapped in. */
export const MARKS = {bold: '**', italic: '_', highlight: '==', strike: '~~', code: '`'} as const
export type Mark = keyof typeof MARKS

/** Wraps the selection in `mark`, or unwraps it when it's wrapped already (inside the selection, or just around it). With
 * nothing selected, the pair goes in with the cursor between. */
export function toggleMark(text: string, start: number, end: number, mark: Mark): CodeEdit {
    const m = MARKS[mark]
    const selected = text.slice(start, end)
    if (selected.length >= 2 * m.length && selected.startsWith(m) && selected.endsWith(m)) {
        const inner = selected.slice(m.length, -m.length)
        return {from: start, to: end, insert: inner, cursor: start + inner.length}
    }
    if (text.slice(start - m.length, start) === m && text.slice(end, end + m.length) === m
        // `**` around an italic `_` isn't the italic's own.
        && !(mark === 'italic' && text.slice(start - 2, start) === '__')) {
        return {from: start - m.length, to: end + m.length, insert: selected, cursor: end - m.length}
    }
    return {from: start, to: end, insert: `${m}${selected}${m}`, cursor: selected ? end + 2 * m.length : start + m.length}
}

/** A link: the selection as its words, the cursor where the address goes. A selected address becomes the address. */
export function insertLink(text: string, start: number, end: number): CodeEdit {
    const selected = text.slice(start, end)
    if (/^https?:\/\/\S+$/.test(selected)) {
        const insert = `[](${selected})`
        return {from: start, to: end, insert, cursor: start + 1}
    }
    const insert = `[${selected}]()`
    return {from: start, to: end, insert, cursor: start + insert.length - 1}
}

/** Line starts a toolbar button puts on each line of the selection. */
export const PREFIXES = {heading: '## ', quote: '> ', bullets: '- ', numbers: '1. ', tasks: '- [ ] '} as const
export type Prefix = keyof typeof PREFIXES

const LEAD = /^(\s*)(#{1,6} |> |- \[[ xX]\] |[-*+] |\d+[.)] )?/

/** Puts `prefix` on every line the selection touches, or takes it off when they all have it. Another line start (a
 * bullet on a line made a heading) gives way to it. */
export function toggleLines(text: string, start: number, end: number, prefix: Prefix): CodeEdit {
    const from = text.lastIndexOf('\n', start - 1) + 1
    const stop = text.indexOf('\n', end === start ? end : end - 1)
    const to = stop === -1 ? text.length : stop
    const lines = text.slice(from, to).split('\n')
    const same = (line: string) => prefix === 'numbers' ? /^\s*\d+[.)] /.test(line)
        : prefix === 'heading' ? /^\s*#{1,6} /.test(line)
            : line.trimStart().startsWith(PREFIXES[prefix])
    // An empty line has nothing to take off: on its own, it gets the start.
    const off = lines.some(line => line.trim()) && lines.every(line => !line.trim() || same(line))
    const out = lines.map((line, n) => {
        if (!line.trim() && lines.length > 1) return line
        const [lead = '', indent = ''] = LEAD.exec(line) ?? []
        const rest = line.slice(lead.length)
        if (off) return indent + rest
        return indent + (prefix === 'numbers' ? `${n + 1}. ` : PREFIXES[prefix]) + rest
    })
    const insert = out.join('\n')
    return {from, to, insert, cursor: from + insert.length}
}

/** Enter at `at` on a list or quote line: the next line starts the same way (the next number, an open task). On one with
 * nothing after its start, the start goes instead, ending the list. Elsewhere, nothing. */
export function continueList(text: string, at: number): CodeEdit | null {
    const from = text.lastIndexOf('\n', at - 1) + 1
    const lineEnd = text.indexOf('\n', at)
    const line = text.slice(from, lineEnd === -1 ? text.length : lineEnd)
    if (inFence(text, from)) return null
    const [lead, indent = '', start = ''] = /^(\s*)(> |- \[[ xX]\] |[-*+] |\d+[.)] )/.exec(line) ?? []
    if (!lead || at < from + lead.length) return null
    if (!line.slice(lead.length).trim() && at === from + line.length) return {from, to: from + line.length, insert: '', cursor: from}
    const next = /^\d+/.test(start) ? start.replace(/^\d+/, n => String(Number(n) + 1))
        : start.startsWith('- [') ? '- [ ] ' : start
    const insert = `\n${indent}${next}`
    return {from: at, to: at, insert, cursor: at + insert.length}
}

/** Whether `at` (a line's start) is inside a fenced code block. */
function inFence(text: string, at: number) {
    return text.slice(0, at).split('\n').filter(line => /^ {0,3}```/.test(line)).length % 2 === 1
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A marker's characters, drawn faint. */
const mk = (s: string) => `<span class="md-mark">${escape(s)}</span>`

const INLINE = /(`+)([^`\n]*?[^`\n])\1(?!`)|(\*\*|__)(?=\S)(.+?)(?<=\S)\3|(==)(?=\S)(.+?)(?<=\S)==|(~~)(?=\S)(.+?)(?<=\S)~~|(\*|_)(?=[^\s*_])(.+?)(?<=[^\s*_])\9(?![*_\w])|(!?\[)([^\]\n]*)\]\(([^)\s]*)\)|(https?:\/\/[^\s<>()]+)/g

/** A line's inline formatting, as spans around the source. Everything in it is kept, character for character, so the
 * drawing lines up with the text box over it. */
function highlightInline(line: string): string {
    let out = ''
    let last = 0
    for (const match of line.matchAll(INLINE)) {
        const at = match.index
        out += escape(line.slice(last, at))
        last = at + match[0].length
        const [whole, tick, code, strong, strongText, , markText, , strikeText, em, emText, open, label, href, url] = match
        if (tick) out += `<span class="md-code">${mk(tick)}${escape(code ?? '')}${mk(tick)}</span>`
        else if (strong) out += `<span class="md-bold">${mk(strong)}${highlightInline(strongText ?? '')}${mk(strong)}</span>`
        else if (markText !== undefined) out += `<span class="md-highlight">${mk('==')}${highlightInline(markText)}${mk('==')}</span>`
        else if (strikeText !== undefined) out += `<span class="md-strike">${mk('~~')}${highlightInline(strikeText)}${mk('~~')}</span>`
        else if (em) out += `<span class="md-italic">${mk(em)}${highlightInline(emText ?? '')}${mk(em)}</span>`
        else if (open) out += `${mk(open)}<span class="md-link">${escape(label ?? '')}</span>${mk(`](${href})`)}`
        else if (url) out += `<span class="md-link">${escape(url)}</span>`
        else out += escape(whole)
    }
    return out + escape(line.slice(last))
}

/** Markdown source as HTML for the drawing behind the box: headings, quotes, list starts and code blocks by line, the
 * rest inline. The text is the source's own, only coloured, so it lines up with the box. */
export function highlightMarkdown(source: string): string {
    let fence = false
    const lines = source.split('\n').map(line => {
        if (/^ {0,3}```/.test(line)) {
            fence = !fence
            return `<span class="md-fence">${escape(line)}</span>`
        }
        if (fence) return `<span class="md-codeblock">${escape(line)}</span>`
        const heading = /^( {0,3}#{1,6} )(.*)$/.exec(line)
        if (heading) return `<span class="md-heading">${mk(heading[1] ?? '')}${highlightInline(heading[2] ?? '')}</span>`
        const quote = /^( {0,3}>+ ?)(.*)$/.exec(line)
        if (quote) return `<span class="md-quote">${mk(quote[1] ?? '')}${highlightInline(quote[2] ?? '')}</span>`
        const item = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )(.*)$/.exec(line)
        if (item) return `${item[1]}<span class="md-list">${escape(item[2] ?? '')}</span>${highlightInline(item[3] ?? '')}`
        if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return mk(line)
        return highlightInline(line)
    })
    // A last empty line still takes its height, as the box gives it one.
    return `${lines.join('\n')}\n`
}
