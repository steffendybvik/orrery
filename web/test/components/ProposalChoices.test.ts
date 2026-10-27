import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Choice, Issue, Picks} from '#shared/roadmap'
import ProposalChoices from '~/components/ProposalChoices.vue'

const CHOICES: Choice[] = [
    {key: 'store', question: 'Where does it live?', pick: 'one', recommended: ['A'], options: [{key: 'A', title: 'SQLite'}, {key: 'B', title: 'Postgres'}]},
    {key: 'extras', question: 'What comes with it?', pick: 'any', recommended: ['X'], options: [{key: 'X', title: 'Backups'}, {key: 'Y', title: 'Exports'}]},
    {key: 'pg', question: 'Which Postgres?', pick: 'one', recommended: [], from: {choice: 'store', option: 'B'}, options: [{key: 'P1', title: 'Managed'}, {key: 'P2', title: 'Own'}]},
]

async function mount(picks: Picks) {
    const updates: Picks[] = []
    const wrapper = await mountSuspended(ProposalChoices, {
        props: {issue: {id: 'ORR-1', choices: CHOICES} as unknown as Issue, modelValue: picks, 'onUpdate:modelValue': (p: Picks) => updates.push(p)},
    })
    return {wrapper, updates}
}

describe('ProposalChoices', () => {
    it('ticks the recommendation and hides a choice down an option not picked', async () => {
        const {wrapper} = await mount({store: ['A'], extras: ['X']})
        expect(wrapper.findAll('fieldset')).toHaveLength(2)
        expect(wrapper.findAll('input:checked').map(i => i.element.closest('label')?.textContent)).toEqual([
            expect.stringContaining('SQLite'), expect.stringContaining('Backups'),
        ])
        expect(wrapper.text()).not.toContain('your call')
    })

    it('shows a choice down an option once that option is picked, as your call', async () => {
        const {wrapper} = await mount({store: ['B'], extras: ['X']})
        expect(wrapper.findAll('fieldset')).toHaveLength(3)
        expect(wrapper.text()).toContain('Going further down B')
        expect(wrapper.text()).toContain('your call')
    })

    it('replaces a pick-one pick and toggles a pick-any one', async () => {
        const {wrapper, updates} = await mount({store: ['A'], extras: ['X']})
        const inputs = wrapper.findAll('input')
        await inputs[1]!.trigger('change')
        expect(updates.at(-1)).toEqual({store: ['B'], extras: ['X']})
        await inputs[2]!.trigger('change')
        expect(updates.at(-1)).toEqual({store: ['A'], extras: []})
        await inputs[3]!.trigger('change')
        expect(updates.at(-1)).toEqual({store: ['A'], extras: ['X', 'Y']})
    })

    it('asks to explore an option without picking it', async () => {
        const {wrapper, updates} = await mount({store: ['A'], extras: ['X']})
        await wrapper.findAll('button')[1]!.trigger('click')
        expect(wrapper.emitted('explore')).toEqual([[CHOICES[0], 'B']])
        expect(updates).toEqual([])
    })
})
