<script setup lang="ts">
import type {Column} from '#shared/roadmap'
import {COLUMNS, PRIORITIES} from '#shared/roadmap'

// ⌘K: every command and place. With nothing typed it offers what fits the page first (the issue's
// commands on an issue, the views on Issues), then the places; typing narrows it all, issues
// included. ↑↓ choose, ↵ runs, Esc closes.
interface Entry { key: string, group: string, label: string, detail?: string, hint?: string, also?: string, run: () => unknown }

const openPalette = useState('palette-open', () => false)
const {byId} = useRoadmaps()
const {ordered: projects} = useProjectOrder()
const {open: openIssue, pathOf} = useIssueLink()
const {filters, active: filtering, clear} = useFilters()
const {view, group} = useLastView()
const {set: setTheme} = useTheme()
const route = useRoute()
const router = useRouter()

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const copied = ref('')

const project = computed(() => byId(route.params.project as string | undefined))
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
        if (order[at + 1]) entries.push({key: 'issue:next', group: 'Issue', label: 'Next issue', detail: order[at + 1], hint: 'j', run: () => router.replace(pathOf(p.id, order[at + 1]!))})
        if (at > 0) entries.push({key: 'issue:previous', group: 'Issue', label: 'Previous issue', detail: order[at - 1], hint: 'k', run: () => router.replace(pathOf(p.id, order[at - 1]!))})
        if (parent) entries.push({key: 'issue:parent', group: 'Issue', label: 'Open its parent', detail: parent.id, run: () => openIssue(p.id, parent.id)})
        entries.push(
            {key: 'issue:chunk', group: 'Issue', label: 'Open its chunk', detail: found.chunk.title, run: () => router.push(chunkPath(p.id, found.chunk.id))},
            {key: 'issue:id', group: 'Copy', label: 'Copy the id', detail: found.issue.id, run: () => copy(found.issue.id, 'id')},
            {key: 'issue:link', group: 'Copy', label: 'Copy the link', run: () => copy(`${location.origin}${path}`, 'link')},
            {key: 'issue:curl', group: 'Copy', label: 'Copy a curl to update it', detail: 'for an agent', run: () => copy(
                `curl -X PATCH ${location.origin}/api/projects/${p.id}/issues/${found.issue.id} -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' -d '{"status": "doing"}'`, 'curl')},
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
        for (const section of sectionsOf(p, route.path).filter(s => !s.active)) {
            entries.push({key: `here:${section.id}`, group: 'Go to', label: `${p.name} ${section.label.toLowerCase()}`, run: () => router.push(section.to)})
        }
    }
    return entries
})

const everywhere = computed<Entry[]>(() => [
    {key: 'go:now', group: 'Go to', label: 'Now across projects', hint: 'g n', run: () => router.push('/now')},
    {key: 'go:urgent', group: 'Go to', label: 'Urgent across projects', hint: 'g u', run: () => router.push('/urgent')},
    {key: 'go:connect', group: 'Go to', label: 'Connect an agent', run: () => router.push('/connect')},
    {key: 'go:settings', group: 'Go to', label: 'App settings', run: () => router.push('/settings')},
    {key: 'project:new', group: 'Project', label: 'New project', run: () => useState('new-project').value = true},
    ...(filtering.value ? [{key: 'filter:clear', group: 'Filter', label: 'Clear the filters', run: clear}] : []),
    ...[...PRIORITIES, 'none'].map(p => ({
        key: `filter:priority:${p}`, group: 'Filter',
        label: `${filters.value.priorities.includes(p) ? 'Stop filtering' : 'Filter'} by priority: ${p === 'none' ? 'none' : `${p} ${PRIORITY_LABEL[p]}`}`,
        run: () => filters.value.priorities = toggle(filters.value.priorities, p),
    })),
    ...COLUMNS.map(c => ({
        key: `filter:column:${c}`, group: 'Filter',
        label: `${filters.value.columns.includes(c) ? 'Stop filtering' : 'Filter'} by column: ${COLUMN_STYLE[c].label}`,
        run: () => filters.value.columns = toggle<Column>(filters.value.columns, c),
    })),
    {key: 'filter:search', group: 'Filter', label: 'Filter by id or title', hint: '/', run: () => nextTick(() => document.getElementById('search')?.focus())},
    {key: 'theme:system', group: 'Theme', label: 'Theme: follow the system', run: () => setTheme('system')},
    {key: 'theme:light', group: 'Theme', label: 'Theme: light', run: () => setTheme('light')},
    {key: 'theme:dark', group: 'Theme', label: 'Theme: dark', run: () => setTheme('dark')},
])

const places = computed<Entry[]>(() => projects.value.flatMap(p => [
    ...sectionsOf(p, '').map(s => ({key: `p:${p.id}:${s.id}`, group: s.id === 'issues' ? 'Project' : s.label, label: s.id === 'issues' ? p.name : `${p.name} ${s.label.toLowerCase()}`, detail: s.id === 'issues' ? `${p.board.counts.done}/${progress(p.board.counts).total}` : undefined, run: () => router.push(s.to)})),
    ...p.board.chunks.map(c => ({key: `c:${p.id}/${c.id}`, group: 'Chunk', label: c.title, detail: p.name, run: () => router.push(chunkPath(p.id, c.id))})),
    ...p.docs.map(d => ({key: `d:${p.id}/${d.id}`, group: 'Doc', label: d.title, detail: p.name, run: () => router.push(`/p/${p.id}/docs/${d.id}`)})),
]))

const issues = computed<Entry[]>(() => projects.value.flatMap(p => allIssues(p).map(({issue: i}) => ({
    key: `i:${p.id}/${i.id}`, group: i.id, label: i.title, detail: p.name, also: i.aliases.join(' '), run: () => openIssue(p.id, i.id),
}))))

const results = computed(() => {
    const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return [...here.value, ...everywhere.value.slice(0, 2), ...places.value.filter(e => e.key.startsWith('p:')), ...everywhere.value.slice(2)]
    const ranked = [here.value, everywhere.value, places.value, issues.value].flatMap((entries, tier) => entries.flatMap(entry => {
        const text = `${entry.group} ${entry.label} ${entry.detail ?? ''} ${entry.also ?? ''}`.toLowerCase()
        if (!words.every(w => text.includes(w))) return []
        const starts = entry.group.toLowerCase().startsWith(words[0]!) || entry.label.toLowerCase().startsWith(words[0]!)
        return [{entry, score: tier * 2 + (starts ? 0 : 1)}]
    }))
    return ranked.sort((a, b) => a.score - b.score).slice(0, 60).map(r => r.entry)
})

watch(query, () => {
    active.value = 0
})
watch(openPalette, isOpen => {
    if (!isOpen) return
    query.value = ''
    active.value = 0
    nextTick(() => input.value?.focus())
})
watch(active, index => nextTick(() => list.value?.children[index]?.scrollIntoView({block: 'nearest'})))

function run(entry: Entry | undefined) {
    if (!entry) return
    openPalette.value = false
    entry.run()
}

function onKey(event: KeyboardEvent) {
    const n = results.value.length
    if (event.key === 'Escape') openPalette.value = false
    else if (event.key === 'Enter') run(results.value[active.value])
    else if (n && (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n'))) active.value = (active.value + 1) % n
    else if (n && (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p'))) active.value = (active.value + n - 1) % n
    else return
    event.preventDefault()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="openPalette" class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" @pointerdown.self="openPalette = false">
      <div class="glass flex max-h-[64vh] w-full max-w-xl animate-fade-up flex-col overflow-hidden rounded-2xl" role="dialog" aria-label="Commands">
        <div class="flex items-center gap-2 border-b border-line px-4">
          <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
              ref="input"
              v-model="query"
              class="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none"
              placeholder="Type a command, or find a project, chunk, doc or issue…"
              aria-label="Type a command or search"
              @keydown="onKey"
          >
          <KeyHint>esc</KeyHint>
        </div>
        <ul ref="list" class="overflow-y-auto p-1" role="listbox">
          <li
              v-for="(entry, index) in results"
              :key="entry.key"
              role="option"
              :aria-selected="index === active"
              class="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[13px]"
              :class="index === active ? 'bg-active' : 'hover:bg-hover'"
              @mouseenter="active = index"
              @click="run(entry)"
          >
            <span class="w-16 shrink-0 truncate text-[11px] text-faint" :class="entry.key.startsWith('i:') ? 'font-mono' : 'uppercase tracking-wide'">{{ entry.group }}</span>
            <span class="min-w-0 flex-1 truncate text-fg">{{ entry.label }}</span>
            <span v-if="entry.detail" class="max-w-40 shrink-0 truncate font-mono text-[11px] text-faint">{{ entry.detail }}</span>
            <KeyHint v-if="entry.hint">{{ entry.hint }}</KeyHint>
          </li>
          <li v-if="!results.length" class="px-3 py-6 text-center text-sm text-faint">Nothing matches</li>
        </ul>
        <div class="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <span><KeyHint>↑</KeyHint> <KeyHint>↓</KeyHint> choose</span>
          <span><KeyHint>↵</KeyHint> run</span>
          <span class="ml-auto">{{ results.length }} {{ results.length === 1 ? 'result' : 'results' }}</span>
        </div>
      </div>
    </div>
  </Teleport>
  <Teleport to="body">
    <div v-if="copied" class="glass fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fade-up rounded-full px-4 py-2 text-xs text-fg">Copied the {{ copied }}</div>
  </Teleport>
</template>
