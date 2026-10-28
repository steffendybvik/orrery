import type {Chat, Session, Upload} from '#shared/roadmap'

// The owner's chat (server/utils/chats.ts): a session started for it alone that they talk to here, with no terminal.
// The pane is open or not (`open`), on a chat (`current`) or, with none, ready to start one on `project`. The chats
// come in over the page's events (`arrived`); one that ends stays on screen, ended, until another is started.
export function useChat() {
    const chats = useState<Chat[]>('chats', () => [])
    const open = useState('chat-open', () => false)
    const current = useState<string | null>('chat-current', () => null)
    /** The chat that just ended, kept to read until the pane starts another. */
    const ended = useState<Chat | null>('chat-ended', () => null)
    const project = useState<string | null>('chat-project', () => null)
    const failed = useState('chat-failed', () => '')
    const {load} = useOwner()
    const {sessions} = useRoadmaps()

    const chat = computed(() => chats.value.find(c => c.id === current.value) ?? (ended.value?.id === current.value ? ended.value : null))
    /** The chat's session, once it has connected. */
    const session = computed<Session | undefined>(() => {
        const on = chat.value
        return on && !on.ended ? (sessions.value[on.project] ?? []).find(s => s.started?.launch === on.id) : undefined
    })

    async function fetchChats() {
        chats.value = await $fetch<Chat[]>('/api/chats').catch(() => chats.value)
        if (!current.value && chats.value[0]) current.value = chats.value[0].id
    }

    function arrived(changed: Chat) {
        const others = chats.value.filter(c => c.id !== changed.id)
        if (changed.ended) {
            chats.value = others
            if (current.value === changed.id) ended.value = changed
        } else chats.value = [changed, ...others]
    }

    /** Opens the pane on the running chat, or ready to start one on `on`. */
    function show(on?: string | null) {
        if (on) project.value = on
        open.value = true
        fetchChats()
    }

    async function start() {
        if (!project.value) return
        failed.value = ''
        try {
            const made = await $fetch<Chat>('/api/chats', {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {project: project.value}})
            ended.value = null
            arrived(made)
            current.value = made.id
        } catch (error) {
            failed.value = errorMessage(error, 'start')
        }
    }

    async function send(text: string, images: string[]) {
        if (!chat.value || chat.value.ended) return false
        failed.value = ''
        try {
            await $fetch(`/api/chats/${chat.value.id}/messages`, {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {text, images}})
            return true
        } catch (error) {
            failed.value = errorMessage(error, 'send')
            return false
        }
    }

    async function end() {
        if (!chat.value || chat.value.ended) return
        failed.value = ''
        await $fetch(`/api/chats/${chat.value.id}/end`, {method: 'POST', headers: {'Orrery-Actor': await load()}})
            .catch(error => failed.value = errorMessage(error, 'end'))
    }

    /** A pasted image, kept by Orrery: its id, to send with the message. */
    async function upload(file: File): Promise<Upload> {
        return $fetch<Upload>('/api/uploads', {method: 'POST', headers: {'Orrery-Actor': await load()}, body: {data: await readAsDataUrl(file), name: file.name || null}})
    }

    return {chats, open, current, chat, session, project, failed, ended, fetchChats, arrived, show, start, send, end, upload}
}
