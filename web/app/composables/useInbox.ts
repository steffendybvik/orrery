import type {Issue, Notice, Project} from '#shared/roadmap'
import {noticeKey} from '#shared/roadmap'

/** Waits on the owner: a decision or feedback they haven't answered on the issue, and not cleared. */
export const isWaiting = (n: Notice) => !n.cleared && !!n.asks && !n.answered

type PageList = 'waiting' | 'inbox' | 'cleared'
interface Loaded {
    items: Notice[]
    /** Older ones wait on the server. */
    more: boolean
    loaded: boolean
}
const PAGE = 50

// The bell and the notifications page: agents' comments, newest first; those after `seenAt` (remembered
// in this browser) are new, and those waiting on the owner count until answered. The bell holds the latest
// 30; the page's lists (waiting, the rest of the inbox, cleared) load a page at a time and change in place.
// Clearing takes them out of the bell for good (they stay on their issues, and under Cleared). Agents'
// proposals waiting on the owner lead the bell as decisions, until decided or cleared: clearing one leaves the
// proposal pending, and it's back if it's put up again.
export function useInbox() {
    const notices = useState<Notice[]>('notices', () => [])
    const lists = useState<Record<PageList, Loaded>>('notice-lists', () => ({
        waiting: {items: [], more: false, loaded: false},
        inbox: {items: [], more: false, loaded: false},
        cleared: {items: [], more: false, loaded: false},
    }))
    /** Pending proposals the bell leaves out, being cleared, as `project/issue@updated_at`: no reason to read it again. */
    const hidden = useState<string[]>('notices-hidden', () => [])
    const seenAt = useState<string>('notices-seen', () => {
        try {
            return localStorage.getItem('orrery-notices-seen') ?? new Date().toISOString()
        } catch {
            return new Date().toISOString()
        }
    })
    const isRead = (n: Notice) => !n.cleared && n.created_at <= seenAt.value && !isWaiting(n)
    const waiting = computed(() => notices.value.filter(isWaiting))
    const unread = computed(() => notices.value.filter(n => !isRead(n)).length)
    const read = computed(() => notices.value.filter(isRead).length)

    /** Marks them read up to the newest, wherever the waiting ones put it in the list. */
    function seen() {
        seenAt.value = notices.value.reduce((newest, n) => n.created_at > newest ? n.created_at : newest, seenAt.value)
        try {
            localStorage.setItem('orrery-notices-seen', seenAt.value)
        } catch {
            // Private windows may refuse; it holds until a reload.
        }
    }

    /** Loads a list of the page's from the start, or its next page with `older`. */
    async function load(list: PageList, older = false) {
        const loaded = lists.value[list]
        // Pages go by comment; cleared proposals all come on the first.
        const before = older ? loaded.items.filter(n => !n.proposal).at(-1)?.id : undefined
        const items = await apiFetch<Notice[]>('/notices', {query: {list, before, limit: PAGE}}).catch(() => null)
        if (!items) return
        lists.value[list] = {items: older ? [...loaded.items, ...items] : items, more: list !== 'waiting' && items.filter(n => !n.proposal).length === PAGE, loaded: true}
    }

    /** A notice from the events stream: into the bell, and the page's list it belongs to. */
    function arrived(notice: Notice) {
        notices.value = [notice, ...notices.value.filter(n => n.id !== notice.id)].slice(0, 50)
        const list = lists.value[isWaiting(notice) ? 'waiting' : 'inbox']
        if (list.loaded) list.items = [notice, ...list.items.filter(n => n.id !== notice.id)]
    }

    /** Clears these notices (comments and proposals), or every read one: out of the bell and the page's lists
     * now, and the server keeps them out. Cleared loads again when it's next shown. */
    async function clear(these?: Notice[]) {
        const gone = these ? new Set(these.map(noticeKey)) : undefined
        const going = (n: Notice) => gone ? gone.has(noticeKey(n)) : !n.proposal && isRead(n)
        hidden.value = [...hidden.value, ...notices.value.filter(n => n.proposal && going(n)).map(n => `${noticeKey(n)}@${n.updated_at}`)]
        notices.value = notices.value.filter(n => !going(n))
        for (const list of ['waiting', 'inbox'] as const) lists.value[list].items = lists.value[list].items.filter(n => !going(n))
        lists.value.cleared.loaded = false
        const body = these
            ? {ids: these.filter(n => !n.proposal).map(n => n.id), proposals: these.filter(n => n.proposal).map(({project, issue}) => ({project, issue}))}
            : {before: seenAt.value}
        await apiFetch('/notices/clear', {method: 'POST', body}).catch(() => {})
        // Older ones move up into the bell's room.
        await refresh()
    }

    /** Reads the bell again, e.g. after the owner answers on an issue; the waiting ones answered since
     * move into the inbox. */
    async function refresh() {
        notices.value = await apiFetch<Notice[]>('/notices').catch(() => notices.value)
        if (!lists.value.waiting.loaded) return
        const before = lists.value.waiting.items
        await load('waiting')
        const still = new Set(lists.value.waiting.items.map(noticeKey))
        // A decided proposal just goes; it was never a comment.
        const answered = before.filter(n => !n.proposal && !still.has(noticeKey(n))).map(n => notices.value.find(b => b.id === n.id) ?? {...n, answered: true})
        const inbox = lists.value.inbox
        if (!inbox.loaded || !answered.length) return
        // Only those inside the pages loaded so far; older ones come with their page.
        const oldest = inbox.more ? inbox.items.at(-1)?.created_at ?? '' : ''
        inbox.items = [...inbox.items, ...answered.filter(n => !n.cleared && n.created_at >= oldest)]
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    }

    /** A project from the events stream: reads the bell again when its agents' proposals waiting on the owner
     * (or what they say) aren't what the bell shows, e.g. one put up, or decided or cleared on another tab. Those
     * it still leaves out are cleared, until they change. */
    function projectChanged(project: Project) {
        const pending: string[] = []
        const walk = (issues: Issue[]) => issues.forEach(i => {
            if (i.proposal === 'pending' && !i.protected) pending.push(`${project.id}/${i.id}@${i.updated_at}`)
            else if (!i.proposal) walk(i.tasks)
        })
        project.board.chunks.forEach(c => walk(c.tasks))
        const shown = () => notices.value.filter(n => n.proposal && n.project === project.id).map(n => `${noticeKey(n)}@${n.updated_at}`)
        if (pending.filter(p => !hidden.value.includes(p)).sort().join() === shown().sort().join()) return
        refresh().then(() => {
            const bell = new Set(shown())
            hidden.value = [...hidden.value.filter(p => !p.startsWith(`${project.id}/`)), ...pending.filter(p => !bell.has(p))]
        })
    }

    return {notices, lists, seenAt, unread, waiting, read, isRead, seen, load, arrived, clear, refresh, projectChanged}
}
