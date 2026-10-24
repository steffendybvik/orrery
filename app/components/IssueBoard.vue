<script setup lang="ts">
import type {Chunk, Column, Issue} from '#shared/roadmap'
import {COLUMNS, total} from '#shared/roadmap'

// Issues as cards in their columns, Doing…Done, as Linear's board. A parent stands for its
// sub-issues. Done starts folded to a count.
const props = defineProps<{chunks: Chunk[], project: string}>()
const {open, isLast} = useIssueLink()
const showDone = ref(false)

const columns = computed(() => {
    const issues = props.chunks.flatMap(chunk => chunk.tasks.map(issue => ({issue, chunk})))
    return COLUMNS.map(column => ({column, cards: issues.filter(({issue}) => issue.column === column)}))
})
const folded = (column: Column) => column === 'done' && !showDone.value
const subs = (issue: Issue) => `${issue.counts.done}/${total(issue.counts)}`
</script>

<template>
  <div class="flex h-full snap-x scroll-px-3 gap-3 overflow-x-auto p-3 sm:scroll-px-4 sm:p-4">
    <section
        v-for="{column, cards} in columns"
        :key="column"
        class="flex shrink-0 snap-start flex-col"
        :class="folded(column) ? 'w-44' : 'w-[85vw] sm:w-80'"
    >
      <header class="mb-2 flex h-7 items-center gap-2 px-1">
        <StatusIcon :column="column" />
        <h2 class="text-[13px] font-medium">{{ COLUMN_STYLE[column].label }}</h2>
        <span class="font-mono text-[11px] text-faint tabular-nums">{{ cards.length }}</span>
        <button v-if="column === 'done' && cards.length" type="button" class="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-hover hover:text-fg" @click="showDone = !showDone">
          {{ showDone ? 'Fold' : 'Show' }}
        </button>
      </header>
      <button
          v-if="folded(column)"
          type="button"
          data-nav
          class="flex flex-col items-start gap-1 rounded-xl border border-dashed border-line p-3 text-left text-xs text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent-500/50"
          @click="showDone = true"
      >
        <span class="font-mono text-lg font-medium text-emerald-600 tabular-nums dark:text-emerald-400">{{ cards.length }}</span>
        {{ cards.length === 1 ? 'issue' : 'issues' }} done
      </button>
      <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
        <article
            v-for="{issue, chunk} in cards"
            :key="issue.id"
            data-nav
            :data-issue="issue.id"
            tabindex="0"
            role="button"
            class="flex cursor-pointer flex-col gap-2 rounded-xl border bg-panel p-3 shadow-sm shadow-black/5 outline-none transition-colors hover:border-faint/40 focus-visible:ring-2 focus-visible:ring-accent-500/50 dark:shadow-black/30"
            :class="isLast(project, issue.id) ? 'border-faint/50' : 'border-line'"
            @click="open(project, issue.id)"
        >
          <div class="flex items-center gap-2 text-[11px] text-faint">
            <span class="font-mono">{{ issue.id }}</span>
            <span class="min-w-0 flex-1 truncate">{{ chunk.title }}</span>
            <PersonAvatar v-if="issue.assignee" :name="issue.assignee" :size="16" />
          </div>
          <div class="flex items-start gap-2">
            <StatusIcon :column="issue.column" :progress="progress(issue.counts).share" class="mt-0.5" />
            <p class="line-clamp-3 min-w-0 flex-1 text-[13px] leading-snug" :class="issue.column === 'done' ? 'text-muted' : 'text-fg'"><InlineText :text="issue.title" /></p>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="grid size-5 place-items-center rounded ring-1 ring-line"><PriorityIcon :priority="issue.priority" :size="12" /></span>
            <span v-if="issue.tasks.length" class="flex h-5 items-center gap-1 rounded px-1.5 font-mono text-[10px] text-faint ring-1 ring-line"><ProgressRing :counts="issue.counts" bare :size="11" />{{ subs(issue) }}</span>
            <LabelChip v-for="label in issue.labels.slice(0, 3)" :key="label" :label="label" />
            <span v-if="issue.comments" class="ml-auto flex items-center gap-1 text-[11px] text-faint">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>{{ issue.comments }}
            </span>
          </div>
        </article>
        <div v-if="!cards.length" class="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-faint">Nothing here</div>
      </div>
    </section>
  </div>
</template>
