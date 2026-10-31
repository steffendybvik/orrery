import type {Issue, Notice, NoticeChange, Project} from '#shared/roadmap'
import {noticeKey} from '#shared/roadmap'

/** Waits on the owner: a decision or feedback they haven't answered on the issue, and not cleared. */
export const isWaiting = (n: Notice) => !n.cleared && !!n.asks && !n.answered

/** Not yet opened on the notifications page. A proposal has no read state: it waits until decided or cleared. */
export const isUnread = (n: Notice) => !n.cleared && !n.proposal && !n.read

/** One line on the notifications page: an issue's notices from one day, or (without `day`) those waiting on the owner,
 * newest first. */
export interface NoticeRow {
    key: string
    day?: string
    project: string
    issue: string
    title: string
    notices: Notice[]
    latest: string
    waiting: boolean
    unread: boolean
}
export interface NoticeDay {
    key: string
    label: string
    total: number
    unread: number
    rows: NoticeRow[]
}

const dayOf = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

function dayLabel(at: Date, now: Date): string {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (dayOf(at) === dayOf(now)) return 'Today'
    if (dayOf(at) === dayOf(yesterday)) return 'Yesterday'
    return at.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long', ...at.getFullYear() === now.getFullYear() ? {} : {year: 'numeric'}})
}

/** Notices by day in this browser's time, newest first, those on one issue that day in one row. */
export function noticeDays(notices: Notice[], now = new Date()): NoticeDay[] {
    const days = new Map<string, NoticeDay>()
    const newestFirst = [...notices].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    for (const notice of newestFirst) {
        const at = new Date(notice.created_at)
        const key = dayOf(at)
        const day = days.get(key) ?? {key, label: dayLabel(at, now), total: 0, unread: 0, rows: []}
        days.set(key, day)
        day.total++
        if (isUnread(notice)) day.unread++
        const rowKey = `${key}/${notice.project}/${notice.issue}`
        let row = day.rows.find(r => r.key === rowKey)
        if (!row) {
            row = {key: rowKey, day: key, project: notice.project, issue: notice.issue, title: notice.title, notices: [], latest: notice.created_at, waiting: false, unread: false}
            day.rows.push(row)
        }
        row.notices.push(notice)
        row.waiting ||= isWaiting(notice)
        row.unread ||= isUnread(notice)
    }
    return [...days.values()]
}

/** What waits on the owner, an issue a line, the newest question first. */
export function waitingRows(notices: Notice[]): NoticeRow[] {
    const rows = new Map<string, NoticeRow>()
    const newestFirst = [...notices].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    for (const notice of newestFirst) {
        const key = `waiting/${notice.project}/${notice.issue}`
        const row = rows.get(key) ?? {key, project: notice.project, issue: notice.issue, title: notice.title, notices: [], latest: notice.created_at, waiting: true, unread: false}
        rows.set(key, row)
        row.notices.push(notice)
    }
    return [...rows.values()]
}

/** A row's status changes: on its day, or since the oldest question it holds. */
export function rowChanges(row: NoticeRow, changes: NoticeChange[]): NoticeChange[] {
    const from = row.notices.at(-1)?.created_at ?? row.latest
    return changes.filter(c => c.project === row.project && c.issue === row.issue
        && (row.day ? dayOf(new Date(c.created_at)) === row.day : c.created_at >= from))
}

/** What a run of changes comes to, oldest first: where it started and ended, or its last step if it came back around. */
export function netChange(changes: NoticeChange[]): {before?: string, after?: string} | null {
    const first = changes[0]
    const last = changes.at(-1)
    if (!first || !last) return null
    return first.before === last.after ? {before: last.before, after: last.after} : {before: first.before, after: last.after}
}

/** The pull request a comment of orrery's says was merged (`pullComment`'s wording). */
export function mergedPull(notice: Pick<Notice, 'body' | 'created_by'>): number | null {
    if (notice.created_by !== 'orrery') return null
    const match = /^\[#(\d+)\]\([^)]*\) was merged into /.exec(notice.body)
    return match ? Number(match[1]) : null
}

/** The newest pull request merged in these notices, as `#n`. */
export function latestMerged(notices: Notice[]): string | null {
    for (const notice of notices) {
        const pull = mergedPull(notice)
        if (pull) return `#${pull}`
    }
    return null
}

/** Markdown as one plain line: links to their text, images and marks gone. */
export function plainText(markdown: string): string {
    return markdown
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^(#+\s+|>\s+|[-*]\s+(\[[ x]\]\s+)?)/, '')
        .replace(/[*_`]/g, '')
        .trim()
}

/** A notice's first line that says anything, without its Markdown: past a heading like "Blockers:" when there's more. */
export function plainLine(body: string): string {
    const lines = body.split('\n').map(plainText).filter(Boolean)
    return lines.find(line => !line.endsWith(':')) ?? lines[0] ?? ''
}

/** What an agent is asking, as well as it can be told: the first bold line with a question in it, else the first sentence
 * that is one, else the last bold sentence (agents end on what they need; a bold word or two is only emphasis), else the
 * first line. */
export function questionOf(body: string): string {
    const bold = [...body.matchAll(/\*\*(.+?)\*\*/g)].map(m => plainText(m[1] ?? ''))
    const asked = body.split('\n').map(plainText).join(' ').match(/[^.?!:]*\?/)?.[0]?.trim()
    return bold.find(b => b.includes('?')) ?? asked ?? bold.findLast(b => b.split(' ').length > 3 && !b.endsWith(':')) ?? plainLine(body)
}

type PageList = 'waiting' | 'inbox' | 'cleared'
interface Loaded {
    items: Notice[]
    /** Older ones wait on the server. */
    more: boolean
    loaded: boolean
}
const PAGE = 50

// The bell and the notifications page: agents' comments, newest first; those after `seenAt` (remembered
// in this browser) are new to the bell, and those waiting on the owner count until answered. Read is apart from that: a
// notice is read once it's opened on the page, kept on the server for each person. The bell holds the latest
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
    const changes = useState<NoticeChange[]>('notice-changes', () => [])
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

    /** Reads the status changes on the bell's issues since a time. */
    async function loadChanges(since: string) {
        changes.value = await apiFetch<NoticeChange[]>('/notices/changes', {query: {since}}).catch(() => changes.value)
    }

    /** A notice from the events stream: into the bell, and the page's list it belongs to. */
    function arrived(notice: Notice) {
        notices.value = [notice, ...notices.value.filter(n => n.id !== notice.id)].slice(0, 50)
        const list = lists.value[isWaiting(notice) ? 'waiting' : 'inbox']
        if (list.loaded) list.items = [notice, ...list.items.filter(n => n.id !== notice.id)]
    }

    /** Marks these read, here at once and then on the server; a proposal has no read state. */
    async function markRead(these: Notice[]) {
        const ids = these.filter(isUnread).map(n => n.id)
        if (!ids.length) return
        const opened = new Set(ids)
        const marked = (items: Notice[]) => items.map(n => opened.has(n.id) ? {...n, read: true} : n)
        notices.value = marked(notices.value)
        for (const list of ['waiting', 'inbox'] as const) lists.value[list].items = marked(lists.value[list].items)
        await apiFetch('/notices/read', {method: 'POST', body: {ids}}).catch(() => {})
    }

    /** Clears these notices (comments and proposals), or every read one: out of the bell and the page's lists
     * now, and the server keeps them out. Cleared loads again when it's next shown. */
    async function clear(these?: Notice[]) {
        const gone = these ? new Set(these.map(noticeKey)) : undefined
        const going = (n: Notice) => gone ? gone.has(noticeKey(n)) : !!n.read && !isWaiting(n)
        hidden.value = [...hidden.value, ...notices.value.filter(n => n.proposal && going(n)).map(n => `${noticeKey(n)}@${n.updated_at}`)]
        notices.value = notices.value.filter(n => !going(n))
        for (const list of ['waiting', 'inbox'] as const) lists.value[list].items = lists.value[list].items.filter(n => !going(n))
        lists.value.cleared.loaded = false
        const body = these
            ? {ids: these.filter(n => !n.proposal).map(n => n.id), proposals: these.filter(n => n.proposal).map(({project, issue}) => ({project, issue}))}
            : {read: true}
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

    return {notices, lists, changes, seenAt, unread, waiting, read, isRead, seen, load, loadChanges, arrived, markRead, clear, refresh, projectChanged}
}
