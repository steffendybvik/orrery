import {describe, expect, it} from 'vitest'
import {matchOf} from '../server/store/schema'

// The text around a doc search's hit (ORR-1111): the start only moves to a space before the match.
describe('a doc search\'s snippet', () => {
    it('keeps the match in a long run without spaces', () => {
        const found = matchOf(`Lead in ${'x'.repeat(80)}backup${'y'.repeat(200)} tail`, ['backup'])
        expect(found).toContain('backup')
        expect(found.startsWith('…') && found.endsWith('…')).toBe(true)
        expect(matchOf(`${'z'.repeat(70)}backup and more`, ['backup'])).toContain('backup')
    })

    it('still starts at a word before the match', () => {
        expect(matchOf(`${'word '.repeat(30)}backup here`, ['backup'])).toMatch(/^…word /)
    })
})
