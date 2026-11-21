import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getMethod, readBody, setResponseStatus} from 'h3'
import type {Chat, ChatMessage, Project} from '#shared/roadmap'
import ChatPane from '~/components/ChatPane.vue'

// What the chat asks the owner to decide, and the pane around the conversation: a setting, a message to other sessions, a
// release, a milestone and a move of issues, each with Allow and Deny (or Allow anyway once something changed since it
// asked), and how each says it was answered; the list of chats (opening one, New chat, removing one and saying why it
// couldn't); the line saying the page's project isn't the chat's; and Pop out, Dock back and the window's links (ORR-938).
// ChatPane.test.ts holds how typing goes, and the cards of their own (ChatDocCard, ChatIssueCard…) their own tests.
const chat = (id: string, more: Partial<Chat> = {}) => ({id, project: 'shed', started_at: '2026-11-04T10:00:00Z', issues: 'todo', messages: [], ...more}) as unknown as Chat
const project = (id: string, name: string) =>
    ({id, name, key: id.slice(0, 3).toUpperCase(), releases: [], docs: [], release_mode: 'none', board: {milestones: [], kinds: {}}}) as unknown as Project
const message = (id: number, more: Partial<ChatMessage>) => ({id, from: 'claude', text: '', images: [], at: '2026-11-04T10:01:00Z', ...more}) as ChatMessage

let answered: {message: string, body: unknown}[] = []
// What a request's answer brings back; and a chat whose removal is refused.
let answer: () => unknown = () => ({})
let refuseRemove = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
for (const id of ['shed', 'barn']) {
    registerEndpoint(`/api/projects/${id}/launches`, () => ({launchers: 1, versions: [''], minimum: '', folders: [], repos: [], every: false, started: 0, starting: 0, total: 0}))
}
registerEndpoint('/api/chats', () => useChat().chats.value)
for (const n of [1, 2, 3, 4, 5]) {
    registerEndpoint(`/api/chats/c1/requests/${n}`, async event => {
        answered.push({message: String(n), body: await readBody(event)})
        return answer()
    })
}
for (const id of ['c1', 'c2']) {
    registerEndpoint(`/api/chats/${id}`, event => {
        if (getMethod(event) !== 'DELETE') return {}
        if (refuseRemove) {
            setResponseStatus(event, 502)
            return {}
        }
        return {}
    })
    registerEndpoint(`/api/chats/${id}/end`, () => ({}))
}

beforeEach(() => {
    answered = []
    answer = () => ({})
    refuseRemove = false
    localStorage.clear()
    clearNuxtState(['chats', 'chat-open', 'chat-picked', 'chat-blank', 'chat-project', 'chat-pinned', 'chat-failed', 'chat-heard', 'chat-large', 'chat-lands', 'launch-state'])
    useRoadmaps().projects.value = [project('shed', 'Shed'), project('barn', 'Barn')]
    useRoadmaps().ready.value = true
    useAppSettings().settings.value.statuses = [{id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'}, {id: 'done', name: 'Done', kind: 'done', color: 'green'}] as never
})
const mounted: {unmount: () => void}[] = []
afterEach(() => {
    for (const pane of mounted.splice(0)) pane.unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** The pane open on chat c1 on Shed, with `messages`, and the others in the list. */
async function mount(messages: ChatMessage[] = [], more: Partial<Chat> = {}, others: Chat[] = [], props: {standalone?: boolean} = {}, route?: string) {
    useChat().chats.value = [chat('c1', {messages, ...more}), ...others]
    useChat().project.value = 'shed'
    useState('chat-picked').value = 'c1'
    useChat().open.value = true
    const pane = await mountSuspended(ChatPane, {props, ...route ? {route} : {}})
    mounted.push(pane)
    await settle()
    const group = (label: string) => pane.find(`[role="group"][aria-label="${label}"]`)
    const press = async (label: string, text: string) => {
        await group(label).findAll('button').find(b => b.text() === text)!.trigger('click')
        await settle()
    }
    return {pane, group, press}
}
async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve))
}

describe('ChatPane, what it asks', () => {
    it('shows a setting it asks to change, from → to, and saves it only on Allow', async () => {
        const {group, press} = await mount([message(1, {request: {setting: 'tint', from: 'none', to: 'blue', state: 'asked'}} as never)])
        expect(group('Change Background tint').text()).toContain('Asks to change a setting')
        expect(group('Change Background tint').text()).toContain('none → blue')
        await press('Change Background tint', 'Allow')
        expect(answered).toEqual([{message: '1', body: {allow: true}}])
    })

    it('says Allow anyway once the setting changed since it asked, and sends that it saw so', async () => {
        const {group, press} = await mount([message(1, {request: {setting: 'tint', from: 'none', to: 'blue', state: 'asked', drifted: [{label: 'Background tint', from: 'none', to: 'red'}]}} as never)])
        expect(group('Change Background tint').find('[data-testid="request-drifted"]').text()).toContain('Background tint is now red (was none)')
        await press('Change Background tint', 'Allow anyway')
        expect(answered[0]!.body).toEqual({allow: true, anyway: true})
    })

    it('keeps its buttons pressed a moment when the answer says it changed again, so a double-click is no second answer', async () => {
        // Only its own wait: what's on its way still lands.
        vi.useFakeTimers({toFake: ['setTimeout']})
        answer = () => ({id: 1, request: {state: 'asked'}})
        const {group} = await mount([message(1, {request: {setting: 'tint', from: 'none', to: 'blue', state: 'asked'}} as never)])
        const allow = () => group('Change Background tint').findAll('button').find(b => b.text() === 'Allow')!
        await allow().trigger('click')
        await settle()
        expect(allow().attributes('disabled')).toBeDefined()
        await vi.advanceTimersByTimeAsync(800)
        await settle()
        expect(allow().attributes('disabled')).toBeUndefined()
    })

    it.each([
        ['allowed', 'Allowed and saved'],
        ['denied', 'Denied: nothing changed'],
        ['expired', 'Expired: not answered in time, or asked again'],
    ])('says a setting was %s', async (state, says) => {
        const {group} = await mount([message(1, {request: {setting: 'tint', from: 'none', to: 'blue', state}} as never)])
        expect(group('Change Background tint').text()).toContain(says)
    })

    it('says Not answered on an ended chat, with nothing to press', async () => {
        const {group} = await mount([message(1, {request: {setting: 'tint', from: 'none', to: 'blue', state: 'asked'}} as never)], {ended: true, ended_at: '2026-11-04T11:00:00Z'} as never)
        expect(group('Change Background tint').text()).toContain('Not answered')
        expect(group('Change Background tint').findAll('button')).toHaveLength(0)
    })

    it('shows a message it asks to send, who to, and sends it only on Send', async () => {
        const {pane, group, press} = await mount([
            message(1, {send: {text: 'Rebase on rc.22', session: 'shed-1', to: ['shed-1'], state: 'asked'}}),
            message(2, {send: {text: 'Stand by', states: ['idle', 'waiting'], projects: ['shed'], to: ['shed-1', 'shed-2'], state: 'asked'}}),
            message(3, {send: {text: 'Hi', to: [], state: 'allowed', sent: []}}),
            message(4, {send: {text: 'Hi', to: ['shed-1'], state: 'allowed', sent: ['shed-1']}}),
            message(5, {send: {text: 'Hi', to: ['shed-2'], state: 'denied'}}),
        ])
        expect(group('Send a message to shed-1').text()).toContain('Asks to send a message as you to shed-1')
        expect(group('Send a message to shed-1, shed-2').text()).toContain('idle or waiting sessions on shed (now shed-1, shed-2)')
        expect(group('Send a message to ').text()).toContain('Sent, but no session fit any more')
        expect(group('Send a message to shed-2').text()).toContain('Not sent')
        expect(group('Send a message to shed-1').exists()).toBe(true)
        await press('Send a message to shed-1, shed-2', "Don't send")
        expect(answered).toEqual([{message: '2', body: {allow: false}}])
        expect(pane.findAll('[role="group"][aria-label="Send a message to shed-1"]').map(g => g.text()).join()).toContain('Sent to shed-1')
    })

    it('shows a release it asks to add or change, each field from → to', async () => {
        const {group, press} = await mount([
            message(1, {release: {version: '1.2', change: false, changes: [{field: 'version', to: '1.2'}, {field: 'notes', to: 'Jars'}], body: {}, state: 'asked'}}),
            message(2, {release: {version: '1.1', change: true, changes: [{field: 'branch', from: 'main', to: 'rc'}], body: {}, state: 'asked', drifted: [{label: 'Branch', from: 'main', to: 'next'}]}} as never),
            message(3, {release: {version: '1.0', change: true, changes: [], body: {}, state: 'denied'}}),
        ])
        expect(group('Add release 1.2').text()).toContain('Asks to add a release')
        expect(group('Add release 1.2').text()).toContain('NotesJars')
        expect(group('Add release 1.2').text()).not.toContain('Version')
        expect(group('Change release 1.1').text()).toContain('main → rc')
        expect(group('Change release 1.0').text()).toContain('Denied: nothing changed')
        await press('Change release 1.1', 'Allow anyway')
        await press('Add release 1.2', 'Deny')
        expect(answered).toEqual([{message: '2', body: {allow: true, anyway: true}}, {message: '1', body: {allow: false}}])
    })

    it('shows a milestone it asks to make or change', async () => {
        const {group, press} = await mount([
            message(1, {milestone: {title: 'Pantry', changes: [{field: 'title', to: 'Pantry'}, {field: 'summary', to: 'Jars and shelves'}], body: {}, state: 'asked'}}),
            message(2, {milestone: {id: 'cellar', title: 'Cellar', changes: [{field: 'title', from: 'Basement', to: 'Cellar'}], body: {}, state: 'asked', drifted: [{label: 'Name', from: 'Basement', to: 'Vault'}]}} as never),
            message(3, {milestone: {title: 'Attic', changes: [], body: {}, state: 'allowed'}}),
        ])
        expect(group('Make milestone Pantry').text()).toContain('Asks to make a milestone')
        expect(group('Make milestone Pantry').text()).toContain('SummaryJars and shelves')
        expect(group('Make milestone Pantry').text()).not.toContain('NamePantry')
        expect(group('Change milestone Cellar').text()).toContain('Asks to change milestone cellar')
        expect(group('Change milestone Cellar').text()).toContain('Basement → Cellar')
        expect(group('Make milestone Attic').text()).toContain('Allowed and saved')
        await press('Change milestone Cellar', 'Allow anyway')
        await press('Make milestone Pantry', 'Allow')
        expect(answered.map(a => a.body)).toEqual([{allow: true, anyway: true}, {allow: true}])
    })

    it("shows the issues it asks to move or assign, each one's change, and what changed since", async () => {
        const changes = [
            {issue: 'SHE-1', title: 'Restock', field: 'status', from: 'todo', to: 'done'},
            {issue: 'SHE-1', title: 'Restock', field: 'assignee', from: null, to: 'claude'},
            {issue: 'SHE-2', title: 'Sweep', field: 'status', from: null, to: 'todo'},
        ]
        const {pane, group, press} = await mount([
            message(1, {move: {changes, body: {ids: ['SHE-1', 'SHE-2']}, moved: ['SHE-1'], drifted: [
                {issue: 'SHE-2', field: 'status', from: 'todo', to: 'done'}, {issue: 'SHE-1', field: 'assignee', from: null, to: 'skoll'},
            ], state: 'asked'}} as never),
            message(2, {move: {changes: [changes[2]!], body: {ids: ['SHE-2']}, state: 'expired'}} as never),
        ])
        const move = group('Move SHE-1, SHE-2')
        expect(move.text()).toContain('Asks to move 2 issues, as you')
        expect(move.text()).toContain('Todo → Done')
        expect(move.text()).toContain('Assignee (nobody) → claude')
        expect(move.text()).toContain('(none) →')
        expect(move.text()).toContain('Moved so far: SHE-1')
        const drifted = move.find('[data-testid="move-drifted"]').text()
        expect(drifted).toContain('SHE-2 is now Done (was Todo)')
        expect(drifted).toContain('SHE-1 is now assigned to skoll (was nobody)')
        expect(move.find('a').attributes('href')).toBe('/w/default/shed/issues/SHE-1')
        expect(group('Move SHE-2').text()).toContain('Asks to move an issue, as you')
        expect(group('Move SHE-2').text()).toContain('Expired: not answered in time')
        await press('Move SHE-1, SHE-2', 'Move anyway')
        expect(answered).toEqual([{message: '1', body: {allow: true, anyway: true}}])
        expect(pane.text()).not.toContain("Couldn't")
    })
})

describe('ChatPane, its list of chats', () => {
    beforeEach(() => {
        vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: () => {}, removeEventListener: () => {}}))
    })

    it("opens another chat from the list, starts a fresh one, and says when one couldn't be removed", async () => {
        const said = (text: string) => message(1, {from: 'owner', text})
        const {pane} = await mount([said('Jars?')], {}, [chat('c2', {started_at: '2026-11-03T10:00:00Z', ended: true, messages: [said('Old shelves\nmore')]} as never)])
        const list = () => pane.find('[data-testid="chat-list"]')
        expect(list().text()).toContain('Jars?')
        expect(list().text()).toContain('Old shelves')
        expect(list().text()).not.toContain('more')
        await list().findAll('button').find(b => b.text().includes('Old shelves'))!.trigger('click')
        expect(useChat().chat.value?.id).toBe('c2')

        refuseRemove = true
        await pane.find('[aria-label="Remove the chat on Shed: Old shelves"]').trigger('click')
        await settle()
        expect(list().find('[role="alert"]').text()).toBe("Couldn't remove it. Is orrery running?")
        refuseRemove = false
        await pane.find('[aria-label="Remove the chat on Shed: Old shelves"]').trigger('click')
        await settle()
        expect(list().text()).not.toContain('Old shelves')

        await list().findAll('button').find(b => b.text().includes('New chat'))!.trigger('click')
        expect(useChat().chat.value).toBeNull()
        expect(pane.find('[data-testid="chat-new-row"]').exists()).toBe(true)
    })

    it('says so when the page is on another project than the chat', async () => {
        const {pane} = await mount([], {}, [], {}, '/w/default/barn')
        useChat().pin('shed')
        await settle()
        expect(pane.find('[data-testid="chat-away"]').text()).toBe("You're on Barn; this chat is about Shed")
    })
})

describe('ChatPane, in a window of its own', () => {
    it("says when the browser won't open the window, and otherwise closes the pane and brings that window back", async () => {
        const focus = vi.fn()
        const opens = vi.fn(() => null as unknown)
        vi.stubGlobal('open', opens)
        const {pane} = await mount()
        const popOut = async () => {
            await pane.find('[aria-label="More for the chat"]').trigger('click')
            await settle()
            await pane.findAll('[role="menuitem"]').find(b => b.text().includes('Break out as own window'))!.trigger('click')
            await settle()
        }
        await popOut()
        expect(useChat().failed.value).toBe('The browser stopped the window opening: allow pop-ups for orrery, then try again')
        expect(opens.mock.calls[0]![0]).toContain('/chat?chat=c1')

        opens.mockReturnValue({closed: false, focus})
        await popOut()
        expect(useChat().open.value).toBe(false)
        await pane.find('button').trigger('click')
        expect(focus).toHaveBeenCalled()
        expect(useChat().open.value).toBe(false)
    })

    it('opens the pane on the chat docked back, and the page a link in the window leads to', async () => {
        const {pane} = await mount([], {}, [chat('c2', {project: 'barn'})])
        useChat().open.value = false
        window.dispatchEvent(new MessageEvent('message', {origin: 'http://elsewhere', data: {orrery: 'chat-dock', chat: 'c2', project: 'barn'}}))
        await settle()
        expect(useChat().open.value).toBe(false)
        window.dispatchEvent(new MessageEvent('message', {origin: location.origin, data: {orrery: 'chat-dock', chat: 'c2', project: 'barn'}}))
        await settle()
        expect(useChat().open.value).toBe(true)
        expect(useChat().chat.value?.id).toBe('c2')
        window.dispatchEvent(new MessageEvent('message', {origin: location.origin, data: {orrery: 'chat-navigate', path: '/w/default/schedules'}}))
        await vi.waitFor(() => expect(useRoute().path).toBe('/w/default/schedules'))
        expect(pane.exists()).toBe(true)
    })

    it('docks back into the window it came from, and sends its links there', async () => {
        const from = {closed: false, focus: vi.fn(), postMessage: vi.fn()}
        vi.stubGlobal('opener', from)
        const closes = vi.spyOn(window, 'close').mockImplementation(() => {})
        const move = {changes: [{issue: 'SHE-1', title: 'Restock', field: 'status', from: 'todo', to: 'done'}], body: {ids: ['SHE-1']}, state: 'asked'}
        const reply = message(2, {text: 'See [the roadmap](/w/default/shed/roadmap), and ![a jar](/api/uploads/u1.png)'})
        const {pane} = await mount([message(1, {move} as never), reply], {}, [], {standalone: true})
        await pane.find('[aria-label="Dock back: the chat in the pane of the window it came from"]').trigger('click')
        expect(from.postMessage).toHaveBeenCalledWith({orrery: 'chat-dock', chat: 'c1', project: 'shed'}, location.origin)
        expect(closes).toHaveBeenCalled()

        // A card's link, which would move this window, and a reply's, which says to open in a new tab (ORR-1331).
        const issue = pane.find('[role="group"][aria-label="Move SHE-1"] a')
        await issue.trigger('click', {button: 0})
        expect(from.postMessage).toHaveBeenLastCalledWith({orrery: 'chat-navigate', path: '/w/default/shed/issues/SHE-1'}, location.origin)
        const roadmap = pane.findAll('a').find(a => a.text() === 'the roadmap')!
        expect(roadmap.attributes('target')).toBe('_blank')
        const click = new MouseEvent('click', {button: 0, bubbles: true, cancelable: true})
        roadmap.element.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(true)
        expect(from.postMessage).toHaveBeenLastCalledWith({orrery: 'chat-navigate', path: '/w/default/shed/roadmap'}, location.origin)
        // A picture opens as it would anywhere.
        const posts = from.postMessage.mock.calls.length
        const picture = new MouseEvent('click', {button: 0, bubbles: true, cancelable: true})
        pane.find('a.image-link').element.dispatchEvent(picture)
        expect(picture.defaultPrevented).toBe(false)
        expect(from.postMessage).toHaveBeenCalledTimes(posts)
        // That window gone, a tab of its own.
        from.closed = true
        const opens = vi.fn()
        vi.stubGlobal('open', opens)
        await issue.trigger('click', {button: 0})
        expect(opens).toHaveBeenCalledWith('/w/default/shed/issues/SHE-1', '_blank')
        // A key held: the browser's to follow.
        await issue.trigger('click', {button: 0, metaKey: true})
        expect(opens).toHaveBeenCalledTimes(1)
        closes.mockRestore()
    })
})
