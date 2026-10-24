import type {Notice} from '#shared/roadmap'

// The bell: agents' comments, newest first; those after `seenAt` (remembered in this browser) are new.
// Clearing takes them out of the bell for good (they stay on their issues).
export function useInbox() {
    const notices = useState<Notice[]>('notices', () => [])
    const seenAt = useState<string>('notices-seen', () => {
        try {
            return localStorage.getItem('orrery-notices-seen') ?? new Date().toISOString()
        } catch {
            return new Date().toISOString()
        }
    })
    const unread = computed(() => notices.value.filter(n => n.createdAt > seenAt.value).length)

    function seen() {
        seenAt.value = notices.value[0]?.createdAt ?? new Date().toISOString()
        try {
            localStorage.setItem('orrery-notices-seen', seenAt.value)
        } catch {
            // Private windows may refuse; it holds until a reload.
        }
    }

    /** Clears these notices, or every read one; the bell drops them now, and the server keeps them out. */
    async function clear(ids?: number[]) {
        const owner = await useOwner().load()
        const body = ids ? {ids} : {before: seenAt.value}
        const gone = new Set(ids ?? notices.value.filter(n => n.createdAt <= seenAt.value).map(n => n.id))
        notices.value = notices.value.filter(n => !gone.has(n.id))
        await $fetch('/api/notices/clear', {method: 'POST', headers: {'Orrery-Actor': owner}, body}).catch(() => {})
        // Older ones move up into the bell's room.
        notices.value = await $fetch<Notice[]>('/api/notices').catch(() => notices.value)
    }

    const read = computed(() => notices.value.filter(n => n.createdAt <= seenAt.value).length)

    return {notices, seenAt, unread, read, seen, clear}
}
