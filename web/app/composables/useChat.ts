import type {Chat, ChatIssues, ChatMessage, Session, Upload} from '#shared/roadmap'

// The owner's chats (server/utils/chats.ts): a session started for each alone that they talk to here, with no terminal.
// As many as the owner likes, on any project, several on one included (ORR-870): `chats` holds them all, running and
// ended, newest first, for the pane's list. The pane is open or not (`open`), large or not (`large`, remembered in this
// browser), and shows one chat (`chat`): the one picked in the list (`pick`), else the newest running on `project`; or,
// after New chat (`fresh`) or with none, it's ready to start one there with the first message. A chat keeps running
// while the pane shows another, and an ended one opens to read. The chats come in over the page's events (`arrived`);
// closing the pane (`close`, × or Esc) only hides it, leaving its chat running, and only a row's × ends one (`end`, ORR-878, ORR-883). Each message says
// which page the owner is on, so the chat knows what "this" is. `/clear` clears its session's context instead (`clear`). Where the issues it makes land (`lands`, Todo or Backlog)
// is the owner's pick beside Send, remembered in this browser for the next chat, and kept by the server on the chat.
// The project a chat would start on follows the page you're on until it's pinned (`pin`, a hand pick pins it); pinned, it
// stays put whatever page you open, remembered in this browser, until unpinned (ORR-588).
export function useChat() {
    const chats = useState<Chat[]>('chats', () => [])
    const open = useState('chat-open', () => false)
    /** The chat picked in the list, shown while it's on the pane's project. */
    const picked = useState<string | null>('chat-picked', () => null)
    /** The project New chat was pressed on: the pane is ready for a fresh one there, whatever else runs on it. */
    const blank = useState<string | null>('chat-blank', () => null)
    const project = useState<string | null>('chat-project', () => null)
    /** The project the pane stays on whatever page is open, picked by hand; none while it follows the page. */
    const pinned = useState<string | null>('chat-pinned', () => {
        try {
            return localStorage.getItem('orrery-chat-project')
        } catch {
            return null
        }
    })
    const failed = useState('chat-failed', () => '')
    /** Counts the changes heard live, so a fetch that was on its way meanwhile doesn't put an older chat back. */
    const heard = useState('chat-heard', () => 0)
    const large = useState('chat-large', () => {
        try {
            return localStorage.getItem('orrery-chat-large') === 'yes'
        } catch {
            return false
        }
    })
    const lands = useState<ChatIssues>('chat-lands', () => {
        try {
            return localStorage.getItem('orrery-chat-issues') === 'backlog' ? 'backlog' : 'todo'
        } catch {
            return 'todo'
        }
    })
    const {chatSessions} = useRoadmaps()

    /** The chat the pane shows: the one picked, while it's on the pane's project, else the newest running there. */
    const chat = computed<Chat | null>(() => {
        const on = project.value
        if (!on || blank.value === on) return null
        const pick = chats.value.find(c => c.id === picked.value)
        if (pick?.project === on) return pick
        return chats.value.find(c => c.project === on && !c.ended) ?? null
    })
    /** The chats running, the pane's included. */
    const running = computed(() => chats.value.filter(c => !c.ended))
    /** The chat's session, once it has connected. */
    const session = computed<Session | undefined>(() => {
        const on = chat.value
        return on && !on.ended ? (chatSessions.value[on.project] ?? []).find(s => s.started?.launch === on.id) : undefined
    })

    async function fetchChats() {
        const since = heard.value
        const fetched = await apiFetch<Chat[]>('/chats').catch(() => null)
        // What came live while it was on its way is newer; the fetch only adds the chats it didn't bring.
        if (fetched) chats.value = heard.value === since ? fetched : [...chats.value, ...fetched.filter(f => !chats.value.some(c => c.id === f.id))]
    }

    function arrived(changed: Chat) {
        heard.value++
        const others = chats.value.filter(c => c.id !== changed.id)
        chats.value = changed.deleted ? others : [changed, ...others].sort((a, b) => b.started_at.localeCompare(a.started_at))
        if (changed.deleted && picked.value === changed.id) picked.value = null
    }

    /** Opens the pane on `on`'s chat, or ready to start one there, unless a project is pinned. */
    function show(on?: string | null) {
        if (on && !pinned.value) project.value = on
        open.value = true
        fetchChats()
    }

    /** Starts a chat on `project`: whether it did. */
    async function start() {
        if (!project.value) return false
        failed.value = ''
        try {
            const made = await apiFetch<Chat>('/chats', {method: 'POST', body: {project: project.value, issues: lands.value}})
            arrived(made)
            picked.value = made.id
            blank.value = null
            return true
        } catch (error) {
            failed.value = errorMessage(error, 'start')
            return false
        }
    }

    /** Sends the owner's message, or a run of them held and sent together (`text` as their parts), as one. */
    async function send(text: string | string[], images: string[]) {
        if (!chat.value || chat.value.ended) return false
        failed.value = ''
        try {
            // The page's tab title, without the app's name it ends in.
            const title = document.title.replace(/\s*·\s*orrery$/, '')
            await apiFetch(`/chats/${chat.value.id}/messages`, {method: 'POST', body: {...Array.isArray(text) ? {parts: text} : {text}, images, page: {path: location.pathname + location.search, title}}})
            return true
        } catch (error) {
            failed.value = errorMessage(error, 'send')
            return false
        }
    }

    /** Clears the chat session's context (`/clear`): it carries on fresh, and the chat marks the cut. */
    async function clear() {
        if (!chat.value || chat.value.ended) return false
        failed.value = ''
        try {
            await apiFetch(`/chats/${chat.value.id}/clear`, {method: 'POST'})
            return true
        } catch (error) {
            failed.value = errorMessage(error, 'clear')
            return false
        }
    }

    /** The owner allowing or denying a setting, a schedule or a message the chat asked for: allowed, it's saved or sent. */
    async function answer(message: number, allow: boolean, anyway = false): Promise<boolean> {
        if (!chat.value || chat.value.ended) return false
        failed.value = ''
        try {
            const asked = await apiFetch<ChatMessage>(`/chats/${chat.value.id}/requests/${message}`, {method: 'POST', body: {allow, ...anyway ? {anyway} : {}}})
            const request = asked.request ?? asked.schedule ?? asked.release ?? asked.chunk ?? asked.move
            return allow && request?.state === 'asked'
        } catch (error) {
            failed.value = errorMessage(error, allow ? 'allow' : 'deny')
            return false
        }
    }

    /** Where the issues the chat makes land from now on: the running chat's, and the next one's. */
    async function land(where: ChatIssues) {
        lands.value = where
        try {
            localStorage.setItem('orrery-chat-issues', where)
        } catch {
            // Private browsing: it holds for this visit only.
        }
        const on = chat.value
        if (!on || on.ended || on.issues === where) return
        failed.value = ''
        try {
            arrived(await apiFetch<Chat>(`/chats/${on.id}`, {method: 'PATCH', body: {issues: where}}))
        } catch (error) {
            failed.value = errorMessage(error, 'save')
        }
    }

    /** New chat: the pane is ready for a fresh one on its project, started by the next message; the others keep running. */
    function fresh() {
        picked.value = null
        blank.value = project.value
        failed.value = ''
    }

    /** Puts the pane on `on`'s chat: for now while it follows the page (the next project page you open moves it on),
     * or pinned there while it's pinned. */
    function switchTo(on: string) {
        if (pinned.value) pin(on)
        else project.value = on
        failed.value = ''
    }

    /** Opens chat `id` in the pane, running or ended, on its project. */
    function view(id: string) {
        const to = chats.value.find(c => c.id === id)
        if (!to) return
        switchTo(to.project)
        picked.value = id
        blank.value = null
    }

    /** Ends chat `id`, its session stopped; it stays in the list, ended, to read. */
    async function end(id: string) {
        const on = chats.value.find(c => c.id === id)
        if (!on || on.ended) return
        arrived({...on, ended: true, ended_at: new Date().toISOString()})
        await apiFetch(`/chats/${id}/end`, {method: 'POST'}).catch(() => {})
    }

    /** Deletes chat `id` (ORR-882), ended first if it runs: it goes from the list, and the pane, if it showed it, goes
     * on to the next in the list, or ready to start one when it was the last. What it made stays. */
    async function remove(id: string) {
        const at = chats.value.findIndex(c => c.id === id)
        const on = chats.value[at]
        if (!on) return
        const shown = chat.value?.id === id
        const next = chats.value[at + 1] ?? chats.value[at - 1]
        await apiFetch(`/chats/${id}`, {method: 'DELETE'})
        arrived({...on, messages: [], ended: true, deleted: true})
        if (!shown) return
        if (next) view(next.id)
        else fresh()
    }

    /** Closes the pane, leaving its chat running (ORR-878): open again, it's on the same conversation. An ended one
     * shown to read is let go, so it opens on the project's running chat, or ready to start one. */
    function close() {
        open.value = false
        if (chat.value?.ended) picked.value = null
        failed.value = ''
    }

    /** Pins the pane to `on`, so it stays there whatever page is open, or unpins it (null) to follow the page again. */
    function pin(on: string | null) {
        pinned.value = on
        if (on) project.value = on
        try {
            if (on) localStorage.setItem('orrery-chat-project', on)
            else localStorage.removeItem('orrery-chat-project')
        } catch {
            // Private browsing: it stays pinned for this visit only.
        }
    }

    function resize() {
        large.value = !large.value
        try {
            if (large.value) localStorage.setItem('orrery-chat-large', 'yes')
            else localStorage.removeItem('orrery-chat-large')
        } catch {
            // Private browsing: it stays large for this visit only.
        }
    }

    /** A pasted image, kept by orrery: its id, to send with the message. */
    async function upload(file: File): Promise<Upload> {
        return apiFetch<Upload>('/uploads', {method: 'POST', body: {data: await readAsDataUrl(file), name: file.name || null}})
    }

    return {chats, running, open, large, chat, session, project, pinned, picked, failed, lands, fetchChats, arrived, show, start, send, clear, land, fresh, switchTo, view, end, remove, answer, close, pin, resize, upload}
}
