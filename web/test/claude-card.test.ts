import {describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {cardFor} from '../../channel/agent-cards.mjs'
// @ts-expect-error: plain JavaScript, no types
import {claudeCard} from '../../channel/claude-card.mjs'

// A session's card says what it runs on as its agent's adapter says it (ORR-1074): Claude Code's, the only one so far.
describe("the agents' cards", () => {
    it("are Claude Code's when no agent is named, or one with no card", () => {
        expect(cardFor()).toBe(claudeCard)
        expect(cardFor('other')).toBe(claudeCard)
    })
})

describe("Claude Code's card", () => {
    it('names the model it runs on and its effort, or in condensed the effort alone', () => {
        const session = {model: 'claude-opus-5-5', effort: 'high'}
        expect(claudeCard.chip(session)).toEqual({label: 'Opus 5.5 · high', title: 'Runs on Opus 5.5, at high effort'})
        expect(claudeCard.chip(session, 'condensed').label).toBe('high')
        expect(claudeCard.chip({model: 'claude-sonnet-5-5'}, 'condensed').label).toBe('Sonnet')
    })

    it('falls back to what orrery started it on, but not to the default, and has no label when nothing is known', () => {
        expect(claudeCard.chip({started: {model: 'claude-haiku-5-5', effort: 'low'}})).toEqual({label: 'Haiku 5.5 · low', title: 'Started on claude-haiku-5-5, low effort'})
        expect(claudeCard.chip({started: {model: 'best'}}).label).toBeUndefined()
        expect(claudeCard.chip({}).label).toBeUndefined()
    })

    it('says in its title when the effort changed from the one it started at', () => {
        expect(claudeCard.chip({effort: 'max', started: {effort: 'high'}}).title).toBe('Started at high effort · at max effort')
    })
})
