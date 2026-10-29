/** What a session at a permission prompt is asking, from the foot of its screen (ORR-489): the prompt's lines from the
 * top of its box (or the rule above it) up to "Do you want to…", without the box, blank lines or the options, and its
 * first line after the heading (the command, the file) as `what`. Null when it shows none. */
export function promptIn(screen: string): {what: string, text: string} | null {
    const lines = screen.replace(/[ \t]+$/gm, '').split('\n')
    const at = (i: number) => lines[i] ?? ''
    const asks = lines.findLastIndex(line => /^[\s│┃]*Do you want to\b/i.test(line))
    if (asks < 0) return null
    // Its top: the box's corner or the rule above it, within 20 lines (what it wants can have blank lines in it),
    // else the 8 lines above.
    let top = asks
    while (top > 0 && asks - top < 20 && !/^\s*([╭┌]|[─━]{8,})/.test(at(top))) top--
    if (!/^\s*([╭┌]|[─━]{8,})/.test(at(top))) top = Math.max(0, asks - 8)
    const kept = lines.slice(top, asks)
        .map(line => line.replace(/^\s*[│┃]|[│┃]\s*$/g, '').trim())
        .filter(line => line && !/^([╭┌╰└]|[─━]{8,})/.test(line))
    return {what: kept[1] ?? kept[0] ?? '', text: kept.join('\n')}
}

/** A tool as the owner reads it: an MCP tool as "orrery · comment" (its server, then the tool), any other by its name. */
export function toolLabel(name: string): string {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
    return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}
