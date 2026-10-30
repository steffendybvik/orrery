// An issue schedule's notes, split for its run (ORR-722): each top-level `- [ ]` line is a sub-issue of what it makes, in
// the order written, with what's indented under it as its notes. The rest stays the parent's. A line in a code block isn't one.

export interface ChecklistItem {
    title: string
    notes?: string
}

const ITEM = /^- \[ \]\s+(\S.*)$/
const FENCE = /^\s*(```|~~~)/

/** A line's bold lead is its title and the rest its notes; with none, it's all title, without a `**` left unclosed. */
function itemOf(line: string): ChecklistItem {
    const lead = /^\*\*(.+?)\*\*\s*(.*)$/.exec(line)
    const unclosed = !lead && (line.match(/\*\*/g)?.length ?? 0) % 2 === 1
    const title = (lead?.[1] ?? (unclosed ? line.replaceAll('**', '') : line)).replace(/[\s:.]+$/, '').trim()
    const rest = lead?.[2]?.replace(/^[:.]\s*/, '').trim()
    return {title, ...rest ? {notes: rest} : {}}
}

export function splitChecklist(words: string): {notes: string, items: ChecklistItem[]} {
    const items: ChecklistItem[] = []
    const rest: string[] = []
    let inFence = false
    let current: ChecklistItem | null = null
    for (const line of words.split('\n')) {
        if (FENCE.test(line) && !(current && /^\s/.test(line))) inFence = !inFence
        const text = inFence ? undefined : ITEM.exec(line)?.[1]
        if (text) {
            current = itemOf(text)
            items.push(current)
        } else if (current && /^\s+\S/.test(line)) {
            const under = line.replace(/^ {1,2}/, '')
            current.notes = current.notes ? `${current.notes}\n${under}` : under
        } else if (line.trim() || !current) {
            if (line.trim()) current = null
            rest.push(line)
        }
    }
    return {notes: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim(), items}
}
