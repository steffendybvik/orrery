/** The permission prompt at the foot of a session's screen, as its pane shows it: from the top of the box (or a rule)
 * above "Do you want to…" through its options, word for word (ORR-489). Null when it shows none. */
export function promptIn(screen: string): string | null {
    const lines = screen.replace(/[ \t]+$/gm, '').split('\n')
    const at = (i: number) => lines[i] ?? ''
    const asks = lines.findLastIndex(line => /^[\s│┃]*Do you want to\b/i.test(line))
    if (asks < 0) return null
    // Its top: the box's corner or the rule above it, within 20 lines (what it wants can have blank lines in it),
    // else the 8 lines above.
    let top = asks
    while (top > 0 && asks - top < 20 && !/^\s*([╭┌]|[─━]{8,})/.test(at(top))) top--
    if (!/^\s*([╭┌]|[─━]{8,})/.test(at(top))) top = Math.max(0, asks - 8)
    while (top < asks && !at(top).trim()) top++
    // Its foot: the box's corner, else the last numbered option and the hint under it.
    let foot = asks
    while (foot + 1 < lines.length && foot - asks < 12 && at(foot + 1).trim()) {
        foot++
        if (/^\s*[╰└]/.test(at(foot))) break
    }
    return lines.slice(top, foot + 1).join('\n')
}
