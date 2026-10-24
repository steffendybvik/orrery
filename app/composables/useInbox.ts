import type {Notice} from '#shared/roadmap'

// The bell: agents' comments, newest first; those after `seenAt` (remembered in this browser) are new.
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

    return {notices, seenAt, unread, seen}
}
