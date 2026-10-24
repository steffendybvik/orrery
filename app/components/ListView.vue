<script setup lang="ts">
import type {Chunk, Column, Counts, Issue} from '#shared/roadmap'
import {COLUMNS} from '#shared/roadmap'

// Top-level issues as rows with their sub-issues under them, in groups that fold: by status (Doing…Done, each row
// saying its chunk) or by chunk. Done starts folded, unless a filter is on.
const props = withDefaults(defineProps<{chunks: Chunk[], project: string, group: 'status' | 'chunk', showChunk?: boolean}>(), {showChunk: true})
const {active} = useFilters()

interface Group { key: string, title: string, column: Column, counts?: Counts, summary?: string, muted?: boolean, issues: {issue: Issue, chunk?: string}[] }

const groups = computed<Group[]>(() => {
    if (props.group === 'chunk') {
        return props.chunks.map(chunk => ({
            key: `chunk:${chunk.id}`, title: chunk.title, column: chunk.column, counts: chunk.counts, summary: chunk.summary, muted: !chunk.id,
            issues: chunk.tasks.map(issue => ({issue})),
        }))
    }
    const all = props.chunks.flatMap(chunk => chunk.tasks.map(issue => ({issue, chunk: props.showChunk ? chunk.title : undefined})))
    return COLUMNS.map(column => ({key: `status:${column}`, title: COLUMN_STYLE[column].label, column, issues: all.filter(i => i.issue.column === column)}))
        .filter(g => g.issues.length)
})

const toggled = ref<Record<string, boolean>>({})
const isOpen = (group: Group) => toggled.value[group.key] ?? (active.value || group.column !== 'done')

function toggle(group: Group) {
    toggled.value = {...toggled.value, [group.key]: !isOpen(group)}
}
</script>

<template>
  <div class="pb-16">
    <section v-for="group in groups" :key="group.key">
      <div
          data-nav
          tabindex="0"
          role="button"
          :aria-expanded="isOpen(group)"
          class="sticky top-0 z-10 flex h-9 cursor-pointer items-center gap-2.5 border-b border-line bg-panel/90 px-3 outline-none backdrop-blur hover:bg-hover focus-visible:bg-active"
          @click="toggle(group)"
      >
        <svg class="size-3 shrink-0 text-faint transition-transform" :class="isOpen(group) && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        <StatusIcon :column="group.column" :progress="group.counts ? progress(group.counts).share : 0.5" />
        <h3 class="min-w-0 truncate text-[13px] font-medium" :class="group.muted && 'text-muted italic'">{{ group.title }}</h3>
        <ProgressRing v-if="group.counts" :counts="group.counts" :size="13" />
        <span v-else class="font-mono text-[11px] text-faint tabular-nums">{{ group.issues.length }}</span>
        <span v-if="group.summary" class="hidden min-w-0 flex-1 truncate text-xs text-faint md:inline"><InlineText :text="group.summary" /></span>
        <span v-if="group.counts" class="ml-auto shrink-0 text-xs" :class="COLUMN_STYLE[group.column].text">{{ COLUMN_STYLE[group.column].label }}</span>
      </div>
      <div v-if="isOpen(group)">
        <IssueRow v-for="{issue, chunk} in group.issues" :key="issue.id" :issue="issue" :project="project" :chunk="chunk" nested />
        <p v-if="!group.issues.length" class="border-b border-line/60 px-10 py-2 text-xs text-faint">No issues yet</p>
      </div>
    </section>
  </div>
</template>
