import {beforeEach, describe, expect, it} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getMethod, readBody, setResponseStatus} from 'h3'
import type {BoardMember, KeyRecord, Person} from '#shared/roadmap'
import BoardMembers from '~/components/BoardMembers.vue'
import KeySettings from '~/components/KeySettings.vue'
import PeopleSettings from '~/components/PeopleSettings.vue'

// Who's on this orrery and on a board, and your keys: what each shows you by who you are, what it sends, and that a
// refusal is said. The server holds the rules (`people.test.ts`, `keys`); these hold the page to them.
let people: Person[] = []
let members: BoardMember[] = []
let keys: KeyRecord[] = []
let sent: {method: string, path: string, body?: unknown}[] = []
let refusal = ''

async function write(event: Parameters<typeof readBody>[0], path: string) {
    if (refusal) {
        setResponseStatus(event, 400)
        return {refused: refusal}
    }
    const method = getMethod(event)
    sent.push({method, path, ...method === 'POST' ? {body: await readBody(event)} : {}})
    return null
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/people', async event => getMethod(event) === 'GET' ? people : await write(event, '/people').then(r => r ? {message: refusal} : {}))
registerEndpoint('/api/people/hate', async event => await write(event, '/people/hate').then(r => r ? {message: refusal} : {}))
registerEndpoint('/api/projects/greenhouse/members', async event => getMethod(event) === 'GET' ? members : await write(event, '/members').then(r => r ? {message: refusal} : {}))
registerEndpoint('/api/projects/greenhouse/members/mani', async event => await write(event, '/members/mani').then(r => r ? {message: refusal} : {}))
registerEndpoint('/api/keys', async event => getMethod(event) === 'GET' ? keys : await write(event, '/keys').then(r => r ? {message: refusal} : {key: 'orr_shown_once'}))
registerEndpoint('/api/keys/laptop', async event => await write(event, '/keys/laptop').then(r => r ? {message: refusal} : {}))

const person = (id: string, role: Person['role'], more: Partial<Person> = {}) => ({id, name: id[0]!.toUpperCase() + id.slice(1), role, ...more}) as Person
const member = (id: string, role: BoardMember['role']) => ({person: id, name: id[0]!.toUpperCase() + id.slice(1), role}) as BoardMember
const key = (id: string, kind: KeyRecord['kind'], more: Partial<KeyRecord> = {}) => ({id, name: `${id} key`, kind, person: 'skoll', created_at: '2026-10-30T07:00:00Z', ...more}) as KeyRecord
const button = (wrapper: {findAll: (s: string) => {text: () => string, attributes: (a: string) => string | undefined}[]}, label: string) =>
    wrapper.findAll('button').find(b => b.attributes('aria-label') === label || b.text() === label) as never as {trigger: (e: string) => Promise<void>, attributes: (a: string) => string | undefined} | undefined

beforeEach(async () => {
    people = [person('skoll', 'owner'), person('hate', 'member'), person('gone', 'member', {removed_at: '2026-10-29T07:00:00Z'})]
    members = []
    keys = []
    sent = []
    refusal = ''
    useState('auth-status').value = null
    useState('acting').value = null
    await usePeople().load()
})

describe('PeopleSettings', () => {
    it('lists who is here, not who was removed, and lets the owner add and remove', async () => {
        const wrapper = await mountSuspended(PeopleSettings)
        expect(wrapper.text()).toContain('Skoll')
        expect(wrapper.text()).toContain('Hate')
        expect(wrapper.text()).not.toContain('Gone')
        // The owner can't be removed.
        expect(button(wrapper as never, 'Remove Skoll')).toBeUndefined()
        await wrapper.find('[aria-label="Their name"]').setValue('  Mani ')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{method: 'POST', path: '/people', body: {name: 'Mani'}}])
        await expect.poll(() => (wrapper.find('[aria-label="Their name"]').element as HTMLInputElement).value).toBe('')
        await button(wrapper as never, 'Remove Hate')!.trigger('click')
        await expect.poll(() => sent.at(-1)).toEqual({method: 'DELETE', path: '/people/hate'})
    })

    it('shows someone else the list, and neither the form nor Remove', async () => {
        useState('auth-status').value = {mode: 'on', person: 'hate'}
        const wrapper = await mountSuspended(PeopleSettings)
        expect(wrapper.text()).toContain('Skoll')
        expect(wrapper.find('form').exists()).toBe(false)
        expect(button(wrapper as never, 'Remove Hate')).toBeUndefined()
    })

    it('says why it was refused and keeps the name', async () => {
        const wrapper = await mountSuspended(PeopleSettings)
        refusal = 'Give them another name'
        await wrapper.find('[aria-label="Their name"]').setValue('Hate')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('Give them another name')
        expect((wrapper.find('[aria-label="Their name"]').element as HTMLInputElement).value).toBe('Hate')
    })
})

describe('BoardMembers', () => {
    it('lets the owner add anyone not on it yet, and remove anyone but its holder', async () => {
        members = [member('skoll', 'owner'), member('mani', 'member')]
        people.push(person('mani', 'member'))
        await usePeople().load()
        const wrapper = await mountSuspended(BoardMembers, {props: {project: 'greenhouse'}})
        await expect.poll(() => wrapper.text()).toContain('holds it')
        expect(button(wrapper as never, 'Remove Skoll')).toBeUndefined()
        // Only those not on it are offered, and those removed from the orrery aren't.
        expect(wrapper.findAll('option').map(o => o.text())).toEqual(['Who to add', 'Hate'])
        expect(button(wrapper as never, 'Add to this board')!.attributes('disabled')).toBeDefined()
        await wrapper.find('select').setValue('hate')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{method: 'POST', path: '/members', body: {person: 'hate'}}])
        await button(wrapper as never, 'Remove Mani')!.trigger('click')
        await expect.poll(() => sent.at(-1)).toEqual({method: 'DELETE', path: '/members/mani'})
    })

    it('lets the one who holds the board manage it, and shows a plain member only who is on it', async () => {
        members = [member('hate', 'owner'), member('mani', 'member')]
        people.push(person('mani', 'member'))
        useState('auth-status').value = {mode: 'on', person: 'hate'}
        await usePeople().load()
        const holding = await mountSuspended(BoardMembers, {props: {project: 'greenhouse'}})
        await expect.poll(() => holding.text()).toContain('holds it')
        expect(button(holding as never, 'Remove Mani')).toBeDefined()

        useState('auth-status').value = {mode: 'on', person: 'mani'}
        const plain = await mountSuspended(BoardMembers, {props: {project: 'greenhouse'}})
        await expect.poll(() => plain.text()).toContain('holds it')
        expect(button(plain as never, 'Remove Hate')).toBeUndefined()
        expect(plain.find('form').exists()).toBe(false)
    })

    it('offers no form when everyone is already on it', async () => {
        members = [member('skoll', 'owner'), member('hate', 'member')]
        const wrapper = await mountSuspended(BoardMembers, {props: {project: 'greenhouse'}})
        await expect.poll(() => wrapper.text()).toContain('holds it')
        expect(wrapper.find('form').exists()).toBe(false)
    })
})

describe('KeySettings', () => {
    it('shows a key once as it is made, with where it goes, and clears the form', async () => {
        const wrapper = await mountSuspended(KeySettings)
        expect(button(wrapper as never, 'Make a key')!.attributes('disabled')).toBeDefined()
        expect(wrapper.text()).not.toContain('Shown this once')
        await wrapper.find('[aria-label="What the key is for"]').setValue('this laptop')
        await wrapper.find('[aria-label="Kind of key"]').setValue('person')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('orr_shown_once')
        expect(wrapper.text()).toContain('Shown this once')
        expect(wrapper.text()).toContain('never goes in a session')
        expect(sent).toEqual([{method: 'POST', path: '/keys', body: {kind: 'person', name: 'this laptop'}}])
        expect((wrapper.find('[aria-label="What the key is for"]').element as HTMLInputElement).value).toBe('')
    })

    it('lists each kind with when it was last used, and only a live one can be revoked', async () => {
        keys = [key('laptop', 'agent', {last_used_at: '2026-10-30T08:00:00Z'}), key('phone', 'person'), key('old', 'agent', {revoked_at: '2026-10-30T09:00:00Z'})]
        const wrapper = await mountSuspended(KeySettings)
        await expect.poll(() => wrapper.text()).toContain('laptop key')
        expect(wrapper.text()).toContain('Agent key, skoll')
        expect(wrapper.text()).toContain('Person key, skoll')
        expect(wrapper.text()).toContain('last used')
        expect(wrapper.text()).toContain('not used yet')
        expect(wrapper.findAll('li').find(li => li.text().includes('old key'))!.classes()).toContain('line-through')
        expect(button(wrapper as never, 'Revoke old key')).toBeUndefined()
        await button(wrapper as never, 'Revoke laptop key')!.trigger('click')
        await expect.poll(() => sent).toEqual([{method: 'DELETE', path: '/keys/laptop'}])
    })

    it('says why it was refused', async () => {
        const wrapper = await mountSuspended(KeySettings)
        refusal = 'Only a person makes keys'
        await wrapper.find('[aria-label="What the key is for"]').setValue('this laptop')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('Only a person makes keys')
        expect(wrapper.text()).not.toContain('Shown this once')
    })
})

