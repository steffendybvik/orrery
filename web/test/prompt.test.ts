import {describe, expect, it} from 'vitest'
import {DEFAULT_FOCUS_PROMPT, renderPrompt} from '#shared/prompt'

describe('a focus prompt', () => {
    const values = {actor: 'skoll_fenrisson', issue: 'LAR-4', title: 'Pantry', where: 'Todo, P1', url: 'http://o/api/projects/larder/issues/LAR-4'}

    it('fills the placeholders and leaves out a line that comes out empty', () => {
        expect(renderPrompt(DEFAULT_FOCUS_PROMPT, values)).toBe('skoll_fenrisson asks you to focus on LAR-4: Pantry [Todo, P1].\nRead it with: curl http://o/api/projects/larder/issues/LAR-4\nRead the project docs it touches before the code, and fix any that turn out wrong.')
        expect(renderPrompt(DEFAULT_FOCUS_PROMPT, {...values, note: 'soon'})).toContain('\nNote: soon\n')
    })

    it("takes an object's built-in names for unknown placeholders", () => {
        expect(renderPrompt('Do {constructor} and {toString}', values)).toBe('Do {constructor} and {toString}')
    })

    it('keeps a line with no placeholders, and an unknown placeholder as written', () => {
        expect(renderPrompt('Hi {actor}.\nBe kind.\n{nope} stays', values)).toBe('Hi skoll_fenrisson.\nBe kind.\n{nope} stays')
    })

    it('adds the standing instructions at the end, or where {instructions} is', () => {
        expect(renderPrompt('Do {issue}.', values, ['Commit', 'Branch'])).toBe('Do LAR-4.\n\nAlso:\n- Commit\n- Branch')
        expect(renderPrompt('First:\n{instructions}\nThen {issue}.', values, ['Commit'])).toBe('First:\n- Commit\nThen LAR-4.')
        expect(renderPrompt('Rules:\n{instructions}\nDo {issue}.', values)).toBe('Rules:\nDo LAR-4.')
    })
})
