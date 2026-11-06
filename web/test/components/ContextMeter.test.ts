import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import ContextMeter from '../../app/components/ContextMeter.vue'

describe('ContextMeter (ORR-968)', () => {
    it('shows how full the window is, with the tokens in the title', async () => {
        const meter = await mountSuspended(ContextMeter, {props: {context: {tokens: 84_000, window: 200_000}}})
        expect(meter.text()).toBe('42%')
        expect(meter.attributes('title')).toBe('84k of 200k tokens in context (42%)')
    })

    it('marks a compacted session, and is the bar alone when condensed', async () => {
        const compacted = await mountSuspended(ContextMeter, {props: {context: {tokens: 300_000, window: 1_000_000, compacted: true}}})
        expect(compacted.text()).toBe('30% ↺')
        expect(compacted.attributes('title')).toBe('300k of 1M tokens in context (30%) · compacted since its last clear')
        expect((await mountSuspended(ContextMeter, {props: {context: {tokens: 1, window: 200_000}, condensed: true}})).text()).toBe('')
    })

    it('shows nothing until the hook has said', async () => {
        expect((await mountSuspended(ContextMeter, {props: {}})).find('[data-testid="context-meter"]').exists()).toBe(false)
    })
})
