import {describe, expect, it} from 'vitest'
import {promptIn, toolLabel} from '../app/utils/permission'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {onYes} from '../../channel/permission-prompt.mjs'

const boxed = `● I'll remove the build folder.

╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│   rm -rf web/.output                         │
│   Remove the build output                    │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for rm commands │
│   3. No, and tell Claude what to do (esc)    │
╰──────────────────────────────────────────────╯
`
const ruled = `● Editing the readme.

────────────────────────────────────────────────
 Edit file

 README.md

 Do you want to make this edit to README.md?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)

`

describe('a permission prompt on a session\'s screen', () => {
    it('is cut from the pane down to what it wants, without its box, blank lines or options', () => {
        expect(promptIn(boxed)).toEqual({what: 'rm -rf web/.output', text: 'Bash command\nrm -rf web/.output\nRemove the build output'})
        expect(promptIn(ruled)).toEqual({what: 'README.md', text: 'Edit file\nREADME.md'})
        expect(promptIn('● Done. The tests pass.\n\n> ')).toBeNull()
    })

    it('is allowed only while it is the last thing on the pane with the cursor on a plain Yes', () => {
        expect(onYes(boxed)).toBe(true)
        expect(onYes(ruled)).toBe(true)
        // The cursor moved to "don't ask again": Enter would pick that, so Allow leaves it.
        expect(onYes(boxed.replace('❯ 1. Yes ', '  1. Yes ').replace('  2. Yes, and', '❯ 2. Yes, and'))).toBe(false)
        // Answered already, and the session went on working.
        expect(onYes(`${boxed}\n● Removed.\n${'● Running the tests…\n'.repeat(10)}`)).toBe(false)
        expect(onYes('> ')).toBe(false)
    })
})

describe('a tool, as the owner reads it (ORR-562)', () => {
    it('names an MCP tool by its server and tool, any other as it is', () => {
        expect(toolLabel('mcp__orrery__comment')).toBe('orrery · comment')
        expect(toolLabel('mcp__claude-in-chrome__read_page')).toBe('claude-in-chrome · read_page')
        expect(toolLabel('Bash')).toBe('Bash')
    })
})
