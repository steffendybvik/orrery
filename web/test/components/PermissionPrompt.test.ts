import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {setResponseStatus} from 'h3'
import type {Session} from '#shared/roadmap'
import PermissionPrompt from '~/components/PermissionPrompt.vue'

// The popup for a session at a permission prompt: what it shows with a screen, with only its hook's word, and started by
// hand, and that a refused answer is said. `permission-prompt.spec.ts` walks the buttons reaching a real launcher.
let screen: string | null = null
let refusal = ''
let answered: string[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/projects/pantry/launches/abc/screen', () => ({screen}))
for (const what of ['allow', 'deny', 'watch']) {
    registerEndpoint(`/api/projects/pantry/launches/abc/${what}`, {method: 'POST', handler: event => {
        if (refusal) {
            setResponseStatus(event, 409)
            return {message: refusal}
        }
        answered.push(what)
        return {}
    }})
}

const session = (more: Partial<Session> = {}) => ({id: 's1', name: 'shelf', project: 'pantry', state: 'waiting', listening: true, since: '', started_at: '', ...more}) as Session
const started = {started: {launch: 'abc', tmux: 't'}} as Partial<Session>
const mounted: VueWrapper[] = []
async function mount(props: {session: Session, hideable?: boolean}) {
    const wrapper = await mountSuspended(PermissionPrompt, {props})
    mounted.push(wrapper as VueWrapper)
    return wrapper
}
const press = (wrapper: Awaited<ReturnType<typeof mount>>, text: string) => wrapper.findAll('button').find(b => b.text() === text)!.trigger('click')

beforeEach(() => {
    screen = null
    refusal = ''
    answered = []
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

describe('PermissionPrompt', () => {
    it('says a session started by hand is answered there, with no buttons to answer it', async () => {
        const wrapper = await mount({session: session({asks: 'Claude needs your permission to use Bash'})})
        expect(wrapper.attributes('aria-label')).toBe('shelf needs permission')
        expect(wrapper.text()).toContain('Claude needs your permission to use Bash')
        expect(wrapper.text()).toContain('Started in a terminal: answer it there.')
        expect(wrapper.findAll('button').map(b => b.text())).not.toContain('Allow')
    })

    it('without a screen, shows the tool it asks for and what it would do', async () => {
        const wrapper = await mount({session: session({asking: {name: 'Bash', detail: 'rm -rf web/.output'}} as Partial<Session>)})
        expect(wrapper.find('[data-asking]').text()).toContain('rm -rf web/.output')
    })

    it('answers Allow, Deny and Open tmux through its launcher', async () => {
        const wrapper = await mount({session: session(started)})
        // Each waits for the last, as the buttons are off while one is on its way.
        for (const [at, button] of ['Allow', 'Deny', 'Open tmux'].entries()) {
            await expect.poll(() => wrapper.findAll('button').find(b => b.text() === button)!.attributes('disabled')).toBeUndefined()
            await press(wrapper, button)
            await expect.poll(() => answered).toHaveLength(at + 1)
        }
        expect(answered).toEqual(['allow', 'deny', 'watch'])
    })

    it('says why an answer was refused, and the buttons come back', async () => {
        const wrapper = await mount({session: session(started)})
        refusal = 'The prompt has gone'
        await press(wrapper, 'Allow')
        await expect.poll(() => wrapper.text()).toContain('The prompt has gone')
        expect(wrapper.findAll('button').find(b => b.text() === 'Allow')!.attributes('disabled')).toBeUndefined()
        expect(answered).toEqual([])
    })

    it('hides until it asks again when it can, and offers no × where it stays', async () => {
        const hiding = await mount({session: session()})
        await hiding.find('[aria-label="Hide until it asks again"]').trigger('click')
        expect(hiding.emitted('close')).toHaveLength(1)
        const staying = await mount({session: session(), hideable: false})
        expect(staying.find('[aria-label="Hide until it asks again"]').exists()).toBe(false)
    })
})
