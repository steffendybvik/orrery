import {describe, expect, it} from 'vitest'
import {heaviest, kindOf, modelFor, weightOf, WORK_KINDS} from '#shared/roadmap'

describe('kinds of work (ORR-868)', () => {
    it("takes an issue's highest-ranked label's kind, else Other", () => {
        expect(kindOf(['docs'])?.id).toBe('docs')
        expect(kindOf(['Documentation'])?.id).toBe('docs')
        expect(kindOf(['docs', 'security'])?.id).toBe('security')
        expect(kindOf(['ui'])?.id).toBe('other')
        expect(kindOf([])?.id).toBe('other')
    })

    it("starts Docs, Roadmap and Chat on sonnet, and the rest on best", () => {
        expect(WORK_KINDS.filter(k => k.model === 'sonnet').map(k => k.id)).toEqual(['docs', 'roadmap', 'chat'])
    })

    it("puts an issue's own model before its kind's", () => {
        expect(modelFor({labels: ['docs']})).toEqual({model: 'sonnet'})
        expect(modelFor({labels: ['docs'], model: 'best', effort: 'high'})).toEqual({model: 'best', effort: 'high'})
        const kinds = WORK_KINDS.map(k => k.id === 'docs' ? {...k, model: 'haiku', effort: 'low' as const} : k)
        expect(modelFor({labels: ['docs']}, kinds)).toEqual({model: 'haiku', effort: 'low'})
        expect(modelFor({labels: ['docs'], model: 'sonnet'}, kinds)).toEqual({model: 'sonnet'})
    })

    it('ranks models by weight, best and unknown ones heaviest, and picks the heaviest of several', () => {
        expect(weightOf('haiku')).toBeLessThan(weightOf('sonnet'))
        expect(weightOf('claude-sonnet-5-5')).toBe(weightOf('sonnet'))
        expect(weightOf('sonnet')).toBeLessThan(weightOf('opus'))
        expect(weightOf('best')).toBeGreaterThan(weightOf('fable'))
        expect(weightOf('something-new')).toBe(weightOf('best'))
        expect(heaviest([{model: 'haiku'}, {model: 'sonnet'}, {model: 'haiku'}])).toEqual({model: 'sonnet'})
        expect(heaviest([])).toEqual({})
    })
})
