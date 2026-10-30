<script setup lang="ts">
import type {Column} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// ⌘K: every command and place, in sections. With nothing typed: Here (what fits the page), Jump to (the
// projects, this one first) and Go to. Typing finds Projects, Issues, Chunks, Docs and Commands, a few of
// each with "N more" to open the rest, best match first; an exact issue id is the Top hit. `>` searches
// commands only, `#` issues, `@` projects, chunks and docs. ↑↓ choose, ⇥ jumps a section, ↵ runs, Esc closes.
// It's a Headless UI Dialog (UiDialog); the list keeps its own keys, as Headless UI's Combobox can't jump a
// section on ⇥ or open "N more" in place, but says the same to a screen reader (the row the input points at).
// Closed issues of projects the page has without them (ORR-447) are asked of orrery as you type.
interface Entry { key: string, group: string, label: string, detail?: string, hint?: string, also?: string, id?: string, run: () => unknown }
type SectionKey = 'top' | 'here' | 'jump' | 'go' | 'projects' | 'issues' | 'chunks' | 'docs' | 'commands'
interface Section { key: SectionKey, title: string, entries: Entry[], hidden: number }
type Row = {kind: 'entry', key: string, entry: Entry, section: SectionKey} | {kind: 'more', key: string, section: SectionKey, n: number}

/** How many of each a search shows before "N more". */
const CAPS: Partial<Record<SectionKey, number>> = {projects: 3, issues: 6, chunks: 3, docs: 3, commands: 5}
const TITLES: Record<SectionKey, string> = {top: 'Top hit', here: 'Here', jump: 'Jump to', go: 'Go to', projects: 'Projects', issues: 'Issues', chunks: 'Chunks', docs: 'Docs', commands: 'Commands'}
/** Scope prefixes: what a search is narrowed to. */
const SCOPES: Record<string, SectionKey[]> = {'>': ['commands'], '#': ['issues'], '@': ['projects', 'chunks', 'docs']}

const openPalette = useState('palette-open', () => false)
const {byId, partial} = useRoadmaps()
const {ordered: projects} = useProjectOrder()
const {open: openIssue, pathOf} = useIssueLink()
const {filters, changed: filtering, clear} = useFilters()
const {view, group} = useLastView()
const {set: setTheme} = useTheme()
const {all: messageAll, one: messageOne, listening} = useMessageSessions()
const {columns} = useStatuses()
const route = useRoute()
const router = useRouter()

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const copied = ref('')

const project = computed(() => byId(route.params.project as string | undefined))
/** The project ⌘K's chat opens on: the chat pane's pinned one, else this page's (ORR-588). */
const chatPinned = useChat().pinned
const chatAbout = computed(() => byId(chatPinned.value ?? undefined) ?? project.value)
const issue = computed(() => route.name === 'p-project-issues-issue' && project.value ? findIssue(project.value, route.params.issue as string) : null)

async function copy(text: string, what: string) {
    if (!await copyText(text)) return
    copied.value = what
    setTimeout(() => copied.value = '', 1500)
}

function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter(v => v !== value) : [...list, value]
}

/** What fits the page on screen. */
const here = computed<Entry[]>(() => {
    const p = project.value
    const entries: Entry[] = []
    const found = issue.value
    if (p && found) {
        const order = allIssues(p).map(i => i.issue.id)
        const at = order.indexOf(found.issue.id)
        const path = pathOf(p.id, found.issue.id)
        const parent = found.parents.at(-1)
        const [next, previous] = [order[at + 1], at > 0 ? order[at - 1] : undefined]
        if (next) entries.push({key: 'issue:next', group: 'Issue', label: 'Next issue', detail: next, hint: 'j', run: () => router.replace(pathOf(p.id, next))})
        if (previous) entries.push({key: 'issue:previous', group: 'Issue', label: 'Previous issue', detail: previous, hint: 'k', run: () => router.replace(pathOf(p.id, previous))})
        if (parent) entries.push({key: 'issue:parent', group: 'Issue', label: 'Open its parent', detail: parent.id, run: () => openIssue(p.id, parent.id)})
        entries.push(
            {key: 'issue:chunk', group: 'Issue', label: 'Open its chunk', detail: found.chunk.title, run: () => router.push(chunkPath(p.id, found.chunk.id))},
            {key: 'issue:id', group: 'Copy', label: 'Copy the id', detail: found.issue.id, run: () => copy(found.issue.id, 'id')},
            {key: 'issue:link', group: 'Copy', label: 'Copy the link', run: () => copy(`${location.origin}${path}`, 'link')},
            {key: 'issue:curl', group: 'Copy', label: 'Copy a curl to update it', detail: 'for an agent', run: () => copy(
                `curl -X PATCH ${location.origin}/api/projects/${p.id}/issues/${found.issue.id} -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' -d '{"status": "in-progress"}'`, 'curl')},
        )
    }
    if (p && route.name === 'p-project') {
        const show = (v: 'list' | 'board') => {
            view.value = v
            router.replace({query: {...route.query, view: v}})
        }
        entries.push(
            {key: 'view:list', group: 'View', label: 'Show as a list', hint: '1', run: () => show('list')},
            {key: 'view:board', group: 'View', label: 'Show as a board', hint: '2', run: () => show('board')},
            {key: 'group:status', group: 'View', label: 'Group the list by status', run: () => (group.value = 'status', show('list'))},
            {key: 'group:chunk', group: 'View', label: 'Group the list by chunk', run: () => (group.value = 'chunk', show('list'))},
        )
    }
    if (p) {
        entries.push({key: 'issue:new', group: 'Issue', label: `New issue in ${p.name}`, hint: 'c', run: () => useNewIssue().open(p.id, route.name === 'p-project-roadmap-chunk' && route.params.chunk !== 'none' ? String(route.params.chunk) : undefined)})
        entries.push({key: 'chunk:new', group: 'Chunk', label: `New chunk in ${p.name}`, run: () => useNewChunk().open(p.id)})
        entries.push({key: 'doc:new', group: 'Doc', label: `New doc in ${p.name}`, run: () => useNewDoc().open(p.id)})
        for (const section of sectionsOf(p, route.path).filter(s => !s.active)) {
            entries.push({key: `here:${section.id}`, group: 'Go to', label: `${p.name} ${section.label.toLowerCase()}`, run: () => router.push(section.to)})
        }
    }
    return entries
})

const everywhere = computed<Entry[]>(() => [
    {key: 'go:mine', group: 'Go to', label: 'My issues and urgent', hint: 'g m', run: () => router.push('/mine')},
    {key: 'go:notifications', group: 'Go to', label: 'Notifications', run: () => router.push('/notifications')},
    {key: 'go:connect', group: 'Go to', label: 'Connect an agent', run: () => router.push('/connect')},
    {key: 'go:sessions', group: 'Go to', label: 'Sessions', run: () => router.push('/sessions')},
    {key: 'go:schedules', group: 'Go to', label: 'Schedules', run: () => router.push('/schedules')},
    {key: 'go:releases', group: 'Go to', label: 'Releases', detail: 'across projects', run: () => router.push('/releases')},
    {key: 'go:events', group: 'Go to', label: 'Events', detail: 'the event log', run: () => router.push('/events')},
    {key: 'go:context', group: 'Go to', label: 'Context', detail: 'what a session is sent', run: () => router.push('/context')},
    {key: 'go:pulls', group: 'Go to', label: 'Pull requests', run: () => router.push('/pulls')},
    {key: 'go:getting-started', group: 'Go to', label: 'Getting started', run: () => {
        useGettingStarted().hide(false)
        router.push('/getting-started')
    }},
    {key: 'go:settings', group: 'Go to', label: 'App settings', run: () => router.push('/settings')},
    ...(projects.value.some(p => p.starts) ? [{key: 'session:start', group: 'Session', label: 'Start session', detail: project.value?.name, run: () => useStartSession().open(project.value?.id ?? null)}] : []),
    ...(listening.value.length ? [{key: 'session:message-all', group: 'Session', label: 'Message sessions', detail: 'every one listening', run: () => messageAll.value = true}] : []),
    ...listening.value.map(s => ({key: `session:message:${s.id}`, group: 'Session', label: `Message ${s.name}`, detail: 'only it hears', run: () => messageOne.value = s})),
    {key: 'chat', group: 'Chat', label: chatAbout.value ? `Chat about ${chatAbout.value.name}` : 'Chat', detail: 'answers and makes issues', run: () => useChat().show(project.value?.id)},
    {key: 'project:new', group: 'Project', label: 'New project', run: () => useState('new-project').value = true},
    ...(filtering.value ? [{key: 'filter:clear', group: 'Filter', label: 'Reset the filters to the open issues', run: clear}] : []),
    ...[...PRIORITIES, 'none'].map(p => ({
        key: `filter:priority:${p}`, group: 'Filter',
        label: `${filters.value.priorities.includes(p) ? 'Stop filtering' : 'Filter'} by priority: ${p === 'none' ? 'none' : `${p} ${PRIORITY_LABEL[p]}`}`,
        run: () => filters.value.priorities = toggle(filters.value.priorities, p),
    })),
    ...columns.value.map(({id: c, label}) => ({
        key: `filter:column:${c}`, group: 'Filter',
        label: `${filters.value.columns.includes(c) ? 'Stop filtering' : 'Filter'} by column: ${label}`,
        run: () => filters.value.columns = toggle<Column>(filters.value.columns, c),
    })),
    {key: 'filter:search', group: 'Filter', label: 'Filter by id or title', hint: '/', run: () => nextTick(() => document.getElementById('search')?.focus())},
    {key: 'theme:system', group: 'Theme', label: 'Theme: follow the system', run: () => setTheme('system')},
    {key: 'theme:light', group: 'Theme', label: 'Theme: light', run: () => setTheme('light')},
    {key: 'theme:dark', group: 'Theme', label: 'Theme: dark', run: () => setTheme('dark')},
])

const places = computed<Entry[]>(() => projects.value.flatMap(p => [
    ...sectionsOf(p, '').map(s => ({key: `p:${p.id}:${s.id}`, group: s.id === 'issues' ? 'Project' : s.label, label: s.id === 'issues' ? p.name : `${p.name} ${s.label.toLowerCase()}`, detail: s.id === 'issues' ? `${p.board.kinds.done}/${progress(p.board.kinds).total}` : undefined, run: () => router.push(s.to)})),
    ...p.board.chunks.map(c => ({key: `c:${p.id}/${c.id}`, group: 'Chunk', label: c.title, detail: p.name, run: () => router.push(chunkPath(p.id, c.id))})),
    ...p.docs.map(d => ({key: `d:${p.id}/${d.id}`, group: 'Doc', label: d.title, detail: p.name, run: () => router.push(`/p/${p.id}/docs/${d.id}`)})),
]))

/** Closed issues matching the query's longest word, from the projects the page has without them, by project. */
const closedFound = ref<Record<string, {id: string, title: string, aliases: string[]}[]>>({})
let asking = 0
let typing: ReturnType<typeof setTimeout> | undefined
watch(query, raw => {
    clearTimeout(typing)
    typing = setTimeout(() => findClosed(raw), 200)
})
onBeforeUnmount(() => clearTimeout(typing))
async function findClosed(raw: string) {
    const word = raw.replace(/^[>#@]/, '').trim().split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? ''
    const ask = ++asking
    const lacking = projects.value.filter(p => partial.value[p.id])
    if (word.length < 2 || raw.startsWith('>') || raw.startsWith('@') || !lacking.length) {
        closedFound.value = {}
        return
    }
    const found = await Promise.all(lacking.map(p => $fetch<{id: string, title: string, aliases: string[]}[]>(`/api/projects/${encodeURIComponent(p.id)}/issues`, {query: {status: 'done,canceled', q: word}})
        .then(list => [p.id, list.slice(0, 50)] as const, () => [p.id, []] as const)))
    if (ask === asking) closedFound.value = Object.fromEntries(found)
}

const issues = computed<Entry[]>(() => projects.value.flatMap(p => {
    const had = allIssues(p).map(({issue: i}) => i)
    const ids = new Set(had.map(i => i.id))
    return [...had, ...partial.value[p.id] ? (closedFound.value[p.id] ?? []).filter(i => !ids.has(i.id)) : []].map(i => ({
        key: `i:${p.id}/${i.id}`, group: 'Issue', id: i.id, label: i.title, detail: p.name, also: i.aliases.join(' '), run: () => openIssue(p.id, i.id),
    }))
}))

/** The sections a search opened past their cap. */
const expanded = ref<SectionKey[]>([])

/** How well an entry matches: 0 its id (or an id it had), 1 its title starts with the query, 2 a word in it
 * does, 3 it's in there somewhere; null when a word of the query isn't. */
function rank(entry: Entry, text: string, words: string[]): number | null {
    const haystack = `${entry.id ?? ''} ${entry.group} ${entry.label} ${entry.detail ?? ''} ${entry.also ?? ''}`.toLowerCase()
    if (!words.every(w => haystack.includes(w))) return null
    const label = entry.label.toLowerCase()
    if (entry.id && [entry.id, ...(entry.also?.split(' ') ?? [])].some(id => id.toLowerCase() === text)) return 0
    if (label.startsWith(text)) return 1
    if (label.split(/[\s:/·-]+/).some(w => w.startsWith(words[0] ?? ''))) return 2
    return 3
}

const sections = computed<Section[]>(() => {
    const raw = query.value.trim()
    const scope = SCOPES[raw[0] ?? ''] ?? null
    const text = (scope ? raw.slice(1) : raw).trim().toLowerCase()
    const words = text.split(/\s+/).filter(Boolean)
    const section = (key: SectionKey, entries: Entry[], cap = Infinity): Section => {
        // A scoped search shows more of its one kind before "N more".
        const shown = expanded.value.includes(key) ? entries : entries.slice(0, scope ? 50 : cap)
        return {key, title: TITLES[key], entries: shown, hidden: entries.length - shown.length}
    }
    if (!words.length && !scope) {
        const current = project.value?.id
        const jump = places.value.filter(e => e.key.startsWith('p:') && e.key.endsWith(':issues'))
            .sort((a, b) => Number(b.key === `p:${current}:issues`) - Number(a.key === `p:${current}:issues`))
        return [
            section('here', here.value.filter(e => e.group !== 'Go to')),
            section('jump', jump),
            section('go', [...here.value.filter(e => e.group === 'Go to'), ...everywhere.value.filter(e => e.group === 'Go to')]),
        ].filter(s => s.entries.length)
    }
    const found = (entries: Entry[]) => entries.flatMap((entry, i) => {
        const score = words.length ? rank(entry, text, words) : 3
        return score === null ? [] : [{entry, score, i}]
    }).sort((a, b) => a.score - b.score || a.i - b.i)
    const hits = found(issues.value)
    const top = hits.filter(h => h.score === 0).map(h => h.entry)
    const pool: Record<'projects' | 'issues' | 'chunks' | 'docs' | 'commands', Entry[]> = {
        projects: found(places.value.filter(e => e.key.startsWith('p:'))).map(h => h.entry),
        issues: hits.filter(h => h.score > 0).map(h => h.entry),
        chunks: found(places.value.filter(e => e.key.startsWith('c:'))).map(h => h.entry),
        docs: found(places.value.filter(e => e.key.startsWith('d:'))).map(h => h.entry),
        commands: found([...here.value, ...everywhere.value]).map(h => h.entry),
    }
    const order = (['projects', 'issues', 'chunks', 'docs', 'commands'] as const).filter(k => !scope || scope.includes(k))
    return [
        ...(!scope || scope.includes('issues')) && top.length ? [section('top', top)] : [],
        ...order.map(k => section(k, pool[k], CAPS[k])),
    ].filter(s => s.entries.length)
})

/** The rows ↑↓ move through: every entry, and each section's "N more". */
const rows = computed<Row[]>(() => sections.value.flatMap(s => [
    ...s.entries.map(entry => ({kind: 'entry' as const, key: `${s.key}:${entry.key}`, entry, section: s.key})),
    ...s.hidden ? [{kind: 'more' as const, key: `${s.key}:more`, section: s.key, n: s.hidden}] : [],
]))
const results = computed(() => rows.value.filter(r => r.kind === 'entry'))
const rowIndex = computed(() => new Map(rows.value.map((r, i) => [r.key, i])))

watch(query, () => {
    active.value = 0
    expanded.value = []
})
watch(openPalette, isOpen => {
    if (!isOpen) return
    query.value = ''
    active.value = 0
    nextTick(() => input.value?.focus())
})
watch(active, index => nextTick(() => list.value?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({block: 'nearest'})))

function run(row: Row | undefined) {
    if (!row) return
    if (row.kind === 'more') {
        // The section opens in place, the choice staying on its first newly shown row.
        expanded.value = [...expanded.value, row.section]
        return
    }
    openPalette.value = false
    row.entry.run()
}

/** ⇥ (⇧⇥ back): to the first row of the next section. */
function jumpSection(step: 1 | -1) {
    const starts = sections.value.flatMap(s => rowIndex.value.get(`${s.key}:${s.entries[0]?.key}`) ?? [])
    const at = starts.findLastIndex(i => i <= active.value)
    active.value = starts[(at + step + starts.length) % starts.length] ?? 0
}

function onKey(event: KeyboardEvent) {
    const n = rows.value.length
    if (event.key === 'Escape') openPalette.value = false
    else if (event.key === 'Enter') run(rows.value[active.value])
    else if (n && event.key === 'Tab') jumpSection(event.shiftKey ? -1 : 1)
    else if (n && (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n'))) active.value = (active.value + 1) % n
    else if (n && (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p'))) active.value = (active.value + n - 1) % n
    else return
    event.preventDefault()
}
</script>

<template>
  <UiDialog :open="openPalette" label="Commands" width="xl" flush class="max-h-[64vh] overflow-hidden" @close="openPalette = false">
    <div class="flex items-center gap-2 border-b border-line px-4">
      <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
          ref="input"
          v-model="query"
          class="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none"
          placeholder="Type a command, or find a project, chunk, doc or issue…"
          aria-label="Type a command or search"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          :aria-activedescendant="rows.length ? `palette-row-${active}` : undefined"
          @keydown="onKey"
      >
      <KeyHint>esc</KeyHint>
    </div>
    <div id="palette-list" ref="list" class="overflow-y-auto p-1" role="listbox" aria-label="Results">
      <section v-for="(s, i) in sections" :key="s.key" :aria-label="s.title" class="pb-1" :class="i > 0 && 'mt-1 border-t border-line'">
        <h3 class="label px-3 pt-2.5 pb-1">{{ s.title }}</h3>
        <div
            v-for="entry in s.entries"
            :key="entry.key"
            :id="`palette-row-${rowIndex.get(`${s.key}:${entry.key}`)}`"
            role="option"
            :data-row="rowIndex.get(`${s.key}:${entry.key}`)"
            :aria-selected="rowIndex.get(`${s.key}:${entry.key}`) === active"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-[13px]"
            :class="rowIndex.get(`${s.key}:${entry.key}`) === active ? 'bg-active' : 'hover:bg-hover'"
            @mouseenter="active = rowIndex.get(`${s.key}:${entry.key}`)!"
            @click="run(rows[rowIndex.get(`${s.key}:${entry.key}`)!])"
        >
          <span v-if="entry.id" class="shrink-0 font-mono text-[11px] text-faint">{{ entry.id }}</span>
          <span class="min-w-0 flex-1 truncate text-fg">{{ entry.label }}</span>
          <span v-if="entry.detail" class="max-w-40 shrink-0 truncate text-[11px] text-faint" :class="!entry.id && 'font-mono'">{{ entry.detail }}</span>
          <KeyHint v-if="entry.hint">{{ entry.hint }}</KeyHint>
        </div>
        <div
            v-if="s.hidden"
            :id="`palette-row-${rowIndex.get(`${s.key}:more`)}`"
            role="option"
            :data-row="rowIndex.get(`${s.key}:more`)"
            :aria-selected="rowIndex.get(`${s.key}:more`) === active"
            class="flex items-center rounded-lg px-3 py-1.5 text-xs text-muted"
            :class="rowIndex.get(`${s.key}:more`) === active ? 'bg-active' : 'hover:bg-hover'"
            @mouseenter="active = rowIndex.get(`${s.key}:more`)!"
            @click="run(rows[rowIndex.get(`${s.key}:more`)!])"
        >{{ s.hidden }} more…</div>
      </section>
      <p v-if="!rows.length" class="px-3 py-6 text-center text-sm text-faint">Nothing matches</p>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-[11px] text-faint">
      <span><KeyHint>↑</KeyHint> <KeyHint>↓</KeyHint> choose</span>
      <span><KeyHint>⇥</KeyHint> section</span>
      <span><KeyHint>↵</KeyHint> run</span>
      <span class="hidden sm:inline"><KeyHint>&gt;</KeyHint> commands · <KeyHint>#</KeyHint> issues · <KeyHint>@</KeyHint> places</span>
      <span class="ml-auto">{{ results.length }} {{ results.length === 1 ? 'result' : 'results' }}</span>
    </div>
  </UiDialog>
  <Teleport to="body">
    <div v-if="copied" class="glass fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fade-up rounded-full px-4 py-2 text-xs text-fg">Copied the {{ copied }}</div>
  </Teleport>
</template>
