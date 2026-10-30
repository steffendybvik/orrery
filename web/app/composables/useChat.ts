import type {Chat, ChatIssues, ChatMessage, Session, Upload} from '#shared/roadmap'

// The owner's chat (server/utils/chats.ts): a session started for it alone that they talk to here, with no terminal.
// The pane is open or not (`open`), large or not (`large`, remembered in this browser), on a chat (`current`) or, with
// none, ready to start one on `project` with the first message. The chats come in over the page's events (`arrived`); closing the pane ends
// its chat (`close`), minimizing it leaves the chat running (`hide`), and one that ends on its own stays on screen, ended, until the pane closes. Each message says
// which page the owner is on, so the chat knows what "this" is. `/clear` clears its session's context instead (`clear`). Where the issues it makes land (`lands`, Todo or Backlog)
// is the owner's pick beside Send, remembered in this browser for the next chat, and kept by the server on the chat.
// The project a chat would start on follows the page you're on until it's pinned (`pin`, a hand pick pins it); pinned, it
// stays put whatever page you open, remembered in this browser, until unpinned (ORR-588).
export function useChat() {
    const chats = useState<Chat[]>('chats', () => [])
    const open = useState('chat-open', () => false)
    const current = useState<string | null>('chat-current', () => null)
    /** The chat that just ended, kept to read until the pane closes or starts another. */
    const ended = useState<Chat | null>('chat-ended', () => null)
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
    const {load} = useOwner()
    const {chatSessions} = useRoadmaps()

    const chat = computed(() => chats.value.find(c => c.id === current.value) ?? (ended.value?.id === current.value ? ended.value : null))
    /** The chat's session, once it has connected. */
    const session = computed<Session | undefined>(() => {
        const on = chat.value
        return on && !on.ended ? (chatSessions.value[on.project] ?? []).find(s => s.started?.launch === on.id) : undefined
    })

    async function fetchChats() {
        const since = heard.value
        const fetched = await $fetch<Chat[]>('/api/chats').catch(() => null)
        // What came live while it was on its way is newer; the fetch only adds the chats it didn't bring.
        if (fetched) chats.value = heard.value === since ? fetched : [...chats.value, ...fetched.filter(f => !chats.value.some(c => c.id === f.id))]
        if (!current.value && chats.value[0]) current.value = chats.value[0].id
    }

    function arrived(changed: Chat) {
        heard.value++
        const others = chats.value.filter(c => c.id !== changed.id)
        if (changed.ended) {
            chats.value = others
            if (current.value === changed.id) ended.value = changed
        } else chats.value = [changed, ...others]
    }

    /** Opens the pane on the running chat, or ready to start one on `on` unless a project is pinned. */
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
            const made = await $fetch<Chat>('/api/chats', {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {project: project.value, issues: lands.value}})
            ended.value = null
            arrived(made)
            current.value = made.id
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
            await $fetch(`/api/chats/${chat.value.id}/messages`, {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {...Array.isArray(text) ? {parts: text} : {text}, images, page: {path: location.pathname + location.search, title}}})
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
            await $fetch(`/api/chats/${chat.value.id}/clear`, {method: 'POST', headers: {'Orrery-Actor': await load()}})
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
            const asked = await $fetch<ChatMessage>(`/api/chats/${chat.value.id}/requests/${message}`, {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {allow, ...anyway ? {anyway} : {}}})
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
            arrived(await $fetch<Chat>(`/api/chats/${on.id}`, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: {issues: where}}))
        } catch (error) {
            failed.value = errorMessage(error, 'save')
        }
    }

    /** Leaves the chat on screen for a fresh one, started by the next message. */
    function fresh() {
        current.value = null
        ended.value = null
        failed.value = ''
    }

    /** Hides the pane, leaving its chat running: opened again, it's on the same conversation. */
    function hide() {
        open.value = false
    }

    /** Closes the pane, ending its chat: open again, it's ready to start another. */
    async function close() {
        open.value = false
        const on = chat.value
        fresh()
        if (!on || on.ended) return
        chats.value = chats.value.filter(c => c.id !== on.id)
        await $fetch(`/api/chats/${on.id}/end`, {method: 'POST', headers: {'Orrery-Actor': await load()}}).catch(() => {})
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
        return $fetch<Upload>('/api/uploads', {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {data: await readAsDataUrl(file), name: file.name || null}})
    }

    return {chats, open, large, current, chat, session, project, pinned, failed, ended, lands, fetchChats, arrived, show, start, send, clear, land, fresh, answer, hide, close, pin, resize, upload}
}
