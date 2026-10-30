import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project, Schedule} from '#shared/roadmap'
import ScheduleList from '~/components/ScheduleList.vue'

// Event schedules stand out from timed ones (ORR-709): a running one comes first with a mark of its own, and a paused one
// still shows the bolt on its trigger line.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const PROJECT = {id: 'greenhouse', name: 'Greenhouse', key: 'GRE', board: {chunks: [], kinds: {}}} as unknown as Project
const schedule = (id: number, title: string, more: Partial<Schedule>) => ({id, project: 'greenhouse', kind: 'issue', title, labels: [], runs: [], enabled: true, timezone: 'UTC', protected: true, created_by: 'skoll', ...more}) as Schedule
const SCHEDULES = [
    schedule(1, 'Later', {cron: '0 9 * * *', next_run: '2099-01-02T09:00:00.000Z'}),
    schedule(2, 'Paused event', {on: 'release.*', enabled: false}),
    schedule(3, 'Sooner', {cron: '0 8 * * *', next_run: '2099-01-01T08:00:00.000Z'}),
    schedule(4, 'Paused timed', {cron: '0 7 * * *', enabled: false}),
    schedule(5, 'Running event', {on: 'issue.status'}),
]

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})

async function rows() {
    const wrapper = await mountSuspended(ScheduleList, {props: {project: PROJECT, schedules: SCHEDULES}})
    mounted.push(wrapper)
    return wrapper.findAll('[data-nav]')
}
const titled = (all: Awaited<ReturnType<typeof rows>>, title: string) => all.find(row => row.text().includes(title))!

describe('ScheduleList', () => {
    it('puts running event schedules first, then timed by soonest, then paused', async () => {
        const order = (await rows()).map(row => SCHEDULES.find(s => row.text().includes(s.title))!.title)
        expect(order.slice(0, 3)).toEqual(['Running event', 'Sooner', 'Later'])
        expect(order.slice(3).sort()).toEqual(['Paused event', 'Paused timed'])
    })

    it('marks a running event schedule On event, and keeps what it runs on in the tooltip', async () => {
        const mark = titled(await rows(), 'Running event').find('[title^="Runs on"]')
        expect(mark.text()).toBe('On event')
        expect(mark.attributes('title')).toBe('Runs on issue.status, once per subject')
        expect(mark.find('svg').exists()).toBe(true)
    })

    it('shows the bolt on every event schedule, running or paused, and on no timed one', async () => {
        const all = await rows()
        const bolts = (title: string) => titled(all, title).findAll('svg.text-teal-600').length
        expect(bolts('Running event')).toBe(1)
        expect(bolts('Paused event')).toBe(1)
        expect(bolts('Sooner')).toBe(0)
        expect(bolts('Paused timed')).toBe(0)
        expect(titled(all, 'Paused event').text()).toContain('Paused')
        expect(titled(all, 'Paused event').text()).not.toContain('On event')
    })
})
