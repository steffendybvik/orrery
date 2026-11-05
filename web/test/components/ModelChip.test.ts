import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import ModelChip from '../../app/components/ModelChip.vue'

const started = (more: object) => ({started: {launch: 'l', tmux: 't', ...more}})
const chip = (session: object, size?: 'normal' | 'condensed') => mountSuspended(ModelChip, {props: {session, size}})

describe('ModelChip (ORR-868, ORR-969)', () => {
    it('names the model it runs on and its effort, with how it started in the title', async () => {
        const runs = await chip({...started({model: 'sonnet', effort: 'high'}), model: 'claude-sonnet-5-5'})
        expect(runs.text()).toBe('Sonnet 5.5 · high')
        expect(runs.attributes('title')).toBe('Started on sonnet, high effort · runs on Sonnet 5.5')
        // Before its hook has said, the model orrery picked.
        expect((await chip(started({model: 'claude-haiku-5-5'}))).text()).toBe('Haiku 5.5')
        expect((await chip(started({model: 'sonnet'}))).text()).toBe('sonnet')
        // One orrery didn't start, from its hook alone (ORR-871).
        const byHand = await chip({model: 'claude-opus-5-5', effort: 'high'})
        expect(byHand.text()).toBe('Opus 5.5 · high')
        expect(byHand.attributes('title')).toBe('Runs on Opus 5.5, at high effort')
    })

    it('shows the effort its hook last said over the one it started at, and an effort on the default model alone (ORR-894)', async () => {
        const switched = await chip({...started({model: 'sonnet', effort: 'high'}), effort: 'low'})
        expect(switched.text()).toBe('sonnet · low')
        expect(switched.attributes('title')).toBe('Started on sonnet, high effort · at low effort')
        const best = await chip(started({model: 'best', effort: 'max'}))
        expect(best.text()).toBe('max')
        expect(best.attributes('title')).toBe('Started at max effort')
        expect((await chip({effort: 'xhigh'})).text()).toBe('xhigh')
    })

    it("shows nothing when there's no model or effort to name", async () => {
        for (const session of [started({model: 'best'}), started({}), {}]) {
            expect((await chip(session)).find('[data-testid="model-chip"]').exists()).toBe(false)
        }
    })

    it('condensed shows the effort only, else the model family', async () => {
        const session = {...started({model: 'best', effort: 'medium'}), model: 'claude-opus-5-5'}
        expect((await chip(session, 'condensed')).text()).toBe('medium')
        expect((await chip(session, 'condensed')).attributes('title')).toBe('Started at medium effort · runs on Opus 5.5')
        expect((await chip({model: 'claude-sonnet-5-5'}, 'condensed')).text()).toBe('Sonnet')
        expect((await chip(started({model: 'best'}), 'condensed')).find('[data-testid="model-chip"]').exists()).toBe(false)
    })
})
