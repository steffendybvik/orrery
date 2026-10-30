import {describe, expect, it} from 'vitest'
import {diffHunks, lineDiff} from '../shared/line-diff'

describe('lineDiff', () => {
    const marked = (from: string, to: string) => lineDiff(from, to).map(l => `${{same: ' ', added: '+', removed: '-'}[l.kind]}${l.text}`)

    it('keeps what stayed and marks what went and came, in order', () => {
        expect(marked('a\nb\nc', 'a\nx\nc')).toEqual([' a', '-b', '+x', ' c'])
        expect(marked('a\nb', 'b\nc')).toEqual(['-a', ' b', '+c'])
    })

    it('reads an empty text as no lines', () => {
        expect(marked('', 'a')).toEqual(['+a'])
        expect(marked('a', '')).toEqual(['-a'])
        expect(marked('', '')).toEqual([])
    })

    it('rebuilds both texts exactly, a blank line or a trailing one included', () => {
        const from = 'one\n\ntwo\nthree\n'
        const to = 'zero\none\n\nthree\nfour\n\n'
        const lines = lineDiff(from, to)
        expect(lines.filter(l => l.kind !== 'added').map(l => l.text).join('\n')).toBe(from)
        expect(lines.filter(l => l.kind !== 'removed').map(l => l.text).join('\n')).toBe(to)
    })

    it('still shows every change when the texts are too big to compare', () => {
        const big = (tag: string) => Array.from({length: 3000}, (_, i) => `${tag}${i}`).join('\n')
        const lines = lineDiff(big('a'), big('b'))
        expect(lines.filter(l => l.kind === 'removed')).toHaveLength(3000)
        expect(lines.filter(l => l.kind === 'added')).toHaveLength(3000)
    })
})

describe('diffHunks', () => {
    it('counts the unchanged runs it leaves out, and never a changed line', () => {
        const from = Array.from({length: 12}, (_, i) => `l${i}`).join('\n')
        const hunks = diffHunks(lineDiff(from, from.replace('l6', 'six')), 1)
        expect(hunks).toEqual([
            {kind: 'skipped', count: 5},
            {kind: 'same', text: 'l5'},
            {kind: 'removed', text: 'l6'},
            {kind: 'added', text: 'six'},
            {kind: 'same', text: 'l7'},
            {kind: 'skipped', count: 4},
        ])
    })
})
