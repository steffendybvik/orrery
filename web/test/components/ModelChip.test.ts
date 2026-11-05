import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import ModelChip from '../../app/components/ModelChip.vue'

const started = (more: object) => ({started: {launch: 'l', tmux: 't', ...more}})

describe('ModelChip (ORR-868)', () => {
    it('names the model orrery started the session on, with its effort and what it runs on in the title', async () => {
        const chip = await mountSuspended(ModelChip, {props: {session: {...started({model: 'sonnet', effort: 'high'}), model: 'claude-sonnet-5-5'}}})
        expect(chip.text()).toBe('sonnet · high')
        expect(chip.attributes('title')).toBe('Started on sonnet, high effort · runs on Sonnet 5.5')
        const pinned = await mountSuspended(ModelChip, {props: {session: started({model: 'claude-haiku-5-5'})}})
        expect(pinned.text()).toBe('Haiku 5.5')
    })

    it('shows the effort its hook last said over the one it started at, and an effort on the default model alone (ORR-894)', async () => {
        const switched = await mountSuspended(ModelChip, {props: {session: {...started({model: 'sonnet', effort: 'high'}), effort: 'low'}}})
        expect(switched.text()).toBe('sonnet · low')
        expect(switched.attributes('title')).toBe('Started on sonnet, high effort · at low effort now')
        const best = await mountSuspended(ModelChip, {props: {session: started({model: 'best', effort: 'max'})}})
        expect(best.text()).toBe('max')
        expect(best.attributes('title')).toBe('Started at max effort')
        expect((await mountSuspended(ModelChip, {props: {session: {effort: 'xhigh'}}})).text()).toBe('xhigh')
    })

    it("shows nothing on Claude Code's default, or for a session orrery didn't start", async () => {
        for (const session of [started({model: 'best'}), started({}), {model: 'claude-opus-5-5'}]) {
            expect((await mountSuspended(ModelChip, {props: {session}})).find('[data-testid="model-chip"]').exists()).toBe(false)
        }
    })

    it('names what it runs on when none was picked, given shown (the chat pane, ORR-936)', async () => {
        const chat = await mountSuspended(ModelChip, {props: {session: {...started({model: 'best', effort: 'medium'}), model: 'claude-opus-5-5'}, shown: true}})
        expect(chat.text()).toBe('Opus 5.5 · medium')
        expect(chat.attributes('title')).toBe('Started at medium effort')
        const picked = await mountSuspended(ModelChip, {props: {session: {...started({model: 'sonnet'}), model: 'claude-sonnet-5-5'}, shown: true}})
        expect(picked.text()).toBe('sonnet')
    })
})
