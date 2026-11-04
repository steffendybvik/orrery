import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import ModelChip from '../../app/components/ModelChip.vue'

const started = (more: object) => ({started: {launch: 'l', tmux: 't', ...more}})

describe('ModelChip (ORR-868)', () => {
    it('names the model orrery started the session on, with its effort and what it runs on in the title', async () => {
        const chip = await mountSuspended(ModelChip, {props: {session: {...started({model: 'sonnet', effort: 'high'}), model: 'claude-sonnet-5-5'}}})
        expect(chip.text()).toBe('sonnet')
        expect(chip.attributes('title')).toBe('Started on sonnet, high effort · runs on Sonnet 5.5')
        const pinned = await mountSuspended(ModelChip, {props: {session: started({model: 'claude-haiku-5-5'})}})
        expect(pinned.text()).toBe('Haiku 5.5')
    })

    it("shows nothing on Claude Code's default, or for a session orrery didn't start", async () => {
        for (const session of [started({model: 'best'}), started({}), {model: 'claude-opus-5-5'}]) {
            expect((await mountSuspended(ModelChip, {props: {session}})).find('[data-testid="model-chip"]').exists()).toBe(false)
        }
    })
})
