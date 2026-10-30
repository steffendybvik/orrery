import {describe, expect, it} from 'vitest'
import {enterInCode, wrapInCode} from '../app/utils/codeBlocks'

const done = (text: string, edit: {from: number, to: number, insert: string, cursor: number}) => {
    const after = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
    return `${after.slice(0, edit.cursor)}|${after.slice(edit.cursor)}`
}

describe('a code block in a text box', () => {
    describe('⌘E', () => {
        it('puts a selection on one line in backticks', () => {
            expect(done('run pnpm test now', wrapInCode('run pnpm test now', 4, 13))).toBe('run `pnpm test`| now')
        })

        it('puts a selection over several lines in a block, on a line of its own', () => {
            expect(done('see a\nb', wrapInCode('see a\nb', 4, 7))).toBe('see \n```\na\nb\n```|')
            expect(done('a\nb', wrapInCode('a\nb', 0, 3))).toBe('```\na\nb\n```|')
        })

        it('starts an empty block with no selection', () => {
            expect(done('', wrapInCode('', 0, 0))).toBe('```\n|\n```')
            expect(done('see', wrapInCode('see', 3, 3))).toBe('see\n```\n|\n```')
        })
    })

    describe('Enter', () => {
        it('closes a block it opens, language and all', () => {
            for (const open of ['```', '```ts', 'text\n```']) expect(done(open, enterInCode(open, open.length)!)).toBe(`${open}\n|\n\`\`\``)
        })

        it("doesn't close one that has its closing line already", () => {
            const text = '```\na\n```'
            expect(done(text, enterInCode(text, 3)!)).toBe('```\n|\na\n```')
        })

        it('is a new line inside a block, and leaves the box its own Enter elsewhere', () => {
            const text = '```\nabc\n```\nafter'
            expect(done(text, enterInCode(text, 7)!)).toBe('```\nabc\n|\n```\nafter')
            // On the closing line, and after the block: a box where Enter sends can send.
            expect(enterInCode(text, 11)).toBeNull()
            expect(enterInCode(text, text.length)).toBeNull()
            expect(enterInCode('plain', 5)).toBeNull()
        })

        it('is a new line in the middle of a line opening a block', () => {
            expect(done('```ts', enterInCode('```ts', 3)!)).toBe('```\n|ts')
        })
    })
})
