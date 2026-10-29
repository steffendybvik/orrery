// Claude Code's permission prompt as tmux's pane shows it ("Do you want to proceed?", then numbered options with ❯ on
// the one picked). The launcher reads it before pressing Enter for the owner's Allow (ORR-489), so an Allow that
// comes late can't answer a different prompt, or pick anything but "Yes" once.

/** The pane's lines with any box drawn around them taken off, and their ends trimmed. */
const linesOf = screen => screen.split('\n').map(line => line.replace(/[│┃]/g, '').trim())

/** Whether the screen ends on a permission prompt whose cursor is on its first option, a plain "Yes" (not "Yes, and
 * don't ask again"), so Enter allows it once. */
export function onYes(screen) {
    const lines = linesOf(screen).filter(Boolean)
    const asks = lines.findLastIndex(line => /^Do you want to\b/i.test(line))
    // The prompt is the last thing on the pane: a few options and a hint line below it at most.
    if (asks < 0 || lines.length - asks > 8) return false
    return lines.slice(asks + 1).some(line => /^❯\s*1\.\s*Yes$/.test(line))
}
