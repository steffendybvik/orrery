import {describe, expect, it} from 'vitest'
import {TERMINAL_KEYS, terminalInput, typeInto} from '../../channel/terminal-keys.mjs'

// What the launcher types into a session's terminal from the page (ORR-1152): text as it is, then listed keys only.
describe('typing into a terminal', () => {
    it('types the text, then presses each key by its tmux name', () => {
        const done: string[] = []
        typeInto({type: (text: string) => done.push(`type ${text}`), press: (key: string) => done.push(`press ${key}`)}, {text: 'yes', keys: ['Enter', 'Ctrl-C', 'Backspace']})
        expect(done).toEqual(['type yes', 'press Enter', 'press C-c', 'press BSpace'])
    })

    it('takes only text with no control characters, and keys it lists', () => {
        expect(terminalInput({text: 'a\tb'})).toEqual({text: 'a\tb', keys: []})
        expect(() => terminalInput({})).toThrow('Send {text} or {keys}')
        expect(() => terminalInput({text: 'ls\n'})).toThrow('control character')
        expect(() => terminalInput({text: '\u001b[A'})).toThrow('control character')
        expect(() => terminalInput({keys: ['C-c']})).toThrow('"keys" has "C-c"')
        // Nothing that would reach tmux as an option or a command.
        expect(() => terminalInput({keys: ['-t other']})).toThrow('"keys" has')
        expect(() => terminalInput({keys: Array(21).fill('Up')})).toThrow('at most 20')
        expect(() => terminalInput({text: 'x'.repeat(2001)})).toThrow('at most 2000')
        expect(Object.values(TERMINAL_KEYS).every(key => /^[A-Za-z-]+$/.test(key) && !key.startsWith('-'))).toBe(true)
    })
})
