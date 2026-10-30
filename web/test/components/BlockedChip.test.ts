import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Issue} from '#shared/roadmap'
import BlockedChip from '~/components/BlockedChip.vue'
import IssueRow from '~/components/IssueRow.vue'

// The Blocked chip (ORR-601): on a row while the issue waits on others not closed yet, naming them on hover, and gone
// once none is left.
const issue = (more: Record<string, unknown> = {}) => ({id: 'GRE-2', title: 'Fill the jars', aliases: [], labels: [], tasks: [], column: 'todo', status: 'todo', kind: 'todo', kinds: {done: 0}, ...more}) as unknown as Issue

const mounted: VueWrapper[] = []
beforeEach(() => {
    useAppSettings().settings.value.statuses = [{id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'}] as never
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

describe('BlockedChip', () => {
    it('says it is blocked, and on what', async () => {
        const wrapper = await mountSuspended(BlockedChip, {props: {blockers: ['GRE-1', 'pantry/PAN-4']}})
        mounted.push(wrapper)
        expect(wrapper.text()).toBe('Blocked')
        expect(wrapper.attributes('title')).toBe('Waiting on GRE-1, pantry/PAN-4')
        expect(wrapper.find('svg').exists()).toBe(true)
    })

    it("shows on a blocked issue's row, and not once its blockers are closed", async () => {
        const wrapper = await mountSuspended(IssueRow, {props: {issue: issue({depends_on: ['GRE-1'], blocked_by: ['GRE-1']}), project: 'greenhouse'}})
        mounted.push(wrapper)
        expect(wrapper.find('[title="Waiting on GRE-1"]').exists()).toBe(true)
        await wrapper.setProps({issue: issue({depends_on: ['GRE-1']})})
        expect(wrapper.find('[title="Waiting on GRE-1"]').exists()).toBe(false)
    })
})
