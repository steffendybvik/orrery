<script setup lang="ts">
import type {Chunk, Column, Counts, Issue, Kinds} from '#shared/roadmap'

// Top-level issues as rows with their sub-issues under them, in groups that fold: by status (Doing…Done, each row
// saying its chunk; started first) or by chunk. Closed groups start folded, unless a filter is on. `#group-end` adds to a group's header.
// An open group's header has a tick (GroupTick) for every row it shows, sub-issues included.
const props = withDefaults(defineProps<{chunks: Chunk[], project: string, group: 'status' | 'chunk', showChunk?: boolean}>(), {showChunk: true})
const {active} = useFilters()
const {columns, look} = useStatuses()

interface Group { key: string, title: string, column: Column, counts?: Counts, kinds?: Kinds, summary?: string, muted?: boolean, issues: {issue: Issue, chunk?: {id: string, title: string}}[] }

const groups = computed<Group[]>(() => {
    if (props.group === 'chunk') {
        return props.chunks.map(chunk => ({
            key: `chunk:${chunk.id}`, title: chunk.title, column: chunk.column, counts: chunk.counts, kinds: chunk.kinds, summary: chunk.summary, muted: !chunk.id,
            issues: chunk.tasks.map(issue => ({issue})),
        }))
    }
    const all = props.chunks.flatMap(chunk => chunk.tasks.map(issue => ({issue, chunk: props.showChunk ? chunk : undefined})))
    return columns.value.map(({id, label}) => ({key: `status:${id}`, title: label, column: id, issues: all.filter(i => i.issue.column === id)}))
        .filter(g => g.issues.length)
})

const toggled = ref<Record<string, boolean>>({})
const isOpen = (group: Group) => toggled.value[group.key] ?? (active.value || !isClosed(look(group.column).kind))

/** The ids of a group's rows, each issue followed by its sub-issues at every depth, as the rows show them. */
const ids = (issues: Issue[]): string[] => issues.flatMap(issue => [issue.id, ...ids(issue.tasks)])

function toggle(group: Group) {
    toggled.value = {...toggled.value, [group.key]: !isOpen(group)}
}
</script>

<template>
  <div class="clear-agent">
    <section v-for="g in groups" :key="g.key">
      <div
          data-nav
          tabindex="0"
          role="button"
          :aria-expanded="isOpen(g)"
          class="group sticky top-0 z-10 flex h-9 items-center gap-2.5 border-b border-line bg-panel/90 px-3 outline-none backdrop-blur hover:tint focus-visible:bg-active"
          @click="toggle(g)"
      >
        <span class="hidden size-[14px] shrink-0 sm:flex">
          <GroupTick v-if="isOpen(g) && g.issues.length" :project="project" :ids="ids(g.issues.map(i => i.issue))" :label="g.title" />
        </span>
        <svg class="size-3 shrink-0 text-faint transition-transform" :class="isOpen(g) && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        <StatusIcon :column="g.column" :progress="g.kinds ? progress(g.kinds).share : 0.5" />
        <h3 class="min-w-0 truncate text-[13px] font-medium" :class="g.muted && 'text-muted italic'">{{ g.title }}</h3>
        <ProgressRing v-if="g.kinds" :kinds="g.kinds" :size="13" />
        <span v-else class="font-mono text-[11px] text-faint tabular-nums">{{ g.issues.length }}</span>
        <span v-if="g.summary" class="hidden min-w-0 flex-1 truncate text-xs text-faint md:inline"><InlineText :text="g.summary" /></span>
        <span v-if="g.counts" class="ml-auto shrink-0 text-xs" :style="{color: readable(look(g.column).color)}">{{ look(g.column).label }}</span>
        <div v-if="$slots['group-end']" class="ml-auto shrink-0"><slot name="group-end" :column="g.column" /></div>
      </div>
      <div v-if="isOpen(g)">
        <IssueRow v-for="{issue, chunk} in g.issues" :key="issue.id" :issue="issue" :project="project" :chunk="chunk" nested />
        <p v-if="!g.issues.length" class="border-b border-line/60 px-10 py-2 text-xs text-faint">No issues yet</p>
      </div>
    </section>
  </div>
</template>
