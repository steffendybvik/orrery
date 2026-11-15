// Typing into a session's terminal from the page (ORR-1152): the owner's text line and keys under its live screen, for
// a phone, where a terminal can't be attached. The launcher types the text as it is (tmux `send-keys -l`), then presses
// each key by its tmux name. Only the keys listed here go, so nothing sent can be a tmux command or another key binding.

/** The keys the page may press, by the name it sends, with tmux's name for each. */
export const TERMINAL_KEYS = Object.freeze({
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right',
    Backspace: 'BSpace',
    'Ctrl-C': 'C-c',
})

/** The longest text typed in one go: a line or a short paste, not a file. */
export const TEXT_MAX = 2000

/** What's sent, checked: `{text?, keys?}`, the text a string with no control characters but a tab, the keys names
 * TERMINAL_KEYS has, at most 20. An error's message says what's wrong; at least one of the two must be there. */
export function terminalInput(body) {
    const text = body?.text ?? ''
    const keys = body?.keys ?? []
    if (typeof text !== 'string') throw new Error('"text" is a string')
    if (text.length > TEXT_MAX) throw new Error(`"text" is ${text.length} characters; send at most ${TEXT_MAX}`)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text)) throw new Error('"text" has a control character: send Enter, Escape or Ctrl-C as "keys"')
    if (!Array.isArray(keys) || keys.length > 20) throw new Error('"keys" is a list of at most 20 keys')
    const wrong = keys.find(key => typeof key !== 'string' || !Object.hasOwn(TERMINAL_KEYS, key))
    if (wrong !== undefined) throw new Error(`"keys" has ${JSON.stringify(wrong)}; use ${Object.keys(TERMINAL_KEYS).join(', ')}`)
    if (!text && !keys.length) throw new Error('Send {text} or {keys}: what to type into the terminal')
    return {text, keys}
}

/** Types it into `pane` (`{type, press}`, a tmux pane as the launcher has it): the text, then each key. */
export function typeInto(pane, body) {
    const {text, keys} = terminalInput(body)
    if (text) pane.type(text)
    for (const key of keys) pane.press(TERMINAL_KEYS[key])
}
