<script setup lang="ts">
// ⌘K: jump to Now, a project or any issue in any project. ↑↓ choose, ↵ goes, Esc closes.
interface Entry { key: string, group: string, label: string, detail?: string, go: () => void }

const openPalette = useState('palette-open', () => false)
const {projects} = useRoadmaps()
const {open: openIssue} = useIssueLink()
const router = useRouter()

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const entries = computed<Entry[]>(() => [
    {key: 'now', group: 'Go to', label: 'Now across projects', detail: 'g n', go: () => router.push('/now')},
    {key: 'urgent', group: 'Go to', label: 'Urgent across projects', detail: 'g u', go: () => router.push('/urgent')},
    ...projects.value.map(p => ({key: `p:${p.id}`, group: 'Project', label: p.name, detail: `${p.board.counts.done}/${progress(p.board.counts).total}`, go: () => router.push(`/p/${p.id}`)})),
    ...projects.value.flatMap(p => p.docs.map(doc => ({
        key: `d:${p.id}/${doc.id}`, group: 'Doc', label: doc.title, detail: p.name, go: () => router.push(`/p/${p.id}/docs/${doc.id}`),
    }))),
    ...projects.value.flatMap(p => allIssues(p).map(({issue}) => ({
        key: `i:${p.id}/${issue.id}`,
        group: issue.id,
        label: issue.title,
        detail: p.name,
        go: () => router.push(`/p/${p.id}`).then(() => openIssue(p.id, issue.id)),
    }))),
])

const results = computed(() => {
    const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return entries.value.slice(0, 12)
    return entries.value
        .map(entry => {
            const text = `${entry.group} ${entry.label} ${entry.detail ?? ''}`.toLowerCase()
            if (!words.every(w => text.includes(w))) return null
            const score = (entry.group.toLowerCase().startsWith(words[0]!) ? 0 : 1) + (entry.key.startsWith('i:') ? 1 : 0)
            return {entry, score}
        })
        .filter(r => r !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, 50)
        .map(r => r.entry)
})

watch(query, () => {
    active.value = 0
})
watch(openPalette, isOpen => {
    if (!isOpen) return
    query.value = ''
    nextTick(() => input.value?.focus())
})
watch(active, index => nextTick(() => list.value?.children[index]?.scrollIntoView({block: 'nearest'})))

function run(entry: Entry | undefined) {
    if (!entry) return
    openPalette.value = false
    entry.go()
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
      <div class="glass flex max-h-[60vh] w-full max-w-xl animate-fade-up flex-col overflow-hidden rounded-2xl" role="dialog" aria-label="Jump to">
        <div class="flex items-center gap-2 border-b border-line px-4">
          <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
              ref="input"
              v-model="query"
              class="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none"
              placeholder="Jump to a project or issue…"
              aria-label="Jump to a project or issue"
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
            <span class="w-16 shrink-0 truncate font-mono text-[11px] text-faint" :class="!entry.key.startsWith('i:') && 'font-sans uppercase tracking-wide'">{{ entry.group }}</span>
            <span class="min-w-0 flex-1 truncate text-fg">{{ entry.label }}</span>
            <span v-if="entry.detail" class="shrink-0 font-mono text-[11px] text-faint">{{ entry.detail }}</span>
          </li>
          <li v-if="!results.length" class="px-3 py-6 text-center text-sm text-faint">Nothing matches</li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>
