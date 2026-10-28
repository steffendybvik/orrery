<script setup lang="ts">
import type {Chunk, Column, Issue} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// Issues as cards in their columns, started first and closed last. A parent stands for its
// sub-issues. A status the filter leaves out has no column, unless a card is in it (a parent kept for a sub-issue
// that matches). Closed columns start folded to a count. Right-clicking a card opens its menu (IssueMenu). An unfolded
// column's header has a tick (GroupTick) for all its cards.
const props = defineProps<{chunks: Chunk[], project: string}>()
const {open, isLast} = useIssueLink()
const {issueUnseen} = useUnseen()
const {open: openMenu} = useIssueMenu()
const {columns: order, look} = useStatuses()
const {selected, isSelected, toggle} = useSelection()
const {settings} = useAppSettings()
const {filters} = useFilters()
function click(event: MouseEvent, issue: Issue) {
    if (selected.value.length && (event.shiftKey || event.metaKey || event.ctrlKey)) toggle(props.project, issue.id, event.shiftKey)
    else open(props.project, issue.id)
}
const unfolded = ref<Column[]>([])

const columns = computed(() => {
    const issues = props.chunks.flatMap(chunk => chunk.tasks.map(issue => ({issue, chunk})))
    const picked = filters.value.columns
    return order.value.map(({id}) => ({column: id, cards: issues.filter(({issue}) => issue.column === id)}))
        .filter(({column, cards}) => !picked.length || picked.includes(column) || cards.length)
})
const folded = (column: Column) => isClosed(look(column).kind) && !unfolded.value.includes(column)
const fold = (column: Column) => unfolded.value = unfolded.value.includes(column) ? unfolded.value.filter(c => c !== column) : [...unfolded.value, column]
const subs = (issue: Issue) => `${issue.kinds.done}/${total(issue.kinds)}`
</script>

<template>
  <div class="flex h-full snap-x scroll-px-3 gap-3 overflow-x-auto p-3 sm:scroll-px-4 sm:p-4">
    <section
        v-for="{column, cards} in columns"
        :key="column"
        class="flex shrink-0 snap-start flex-col"
        :class="folded(column) ? 'w-44' : 'w-[85vw] sm:w-80'"
    >
      <header class="group mb-2 flex h-7 items-center gap-2 px-1">
        <GroupTick v-if="!folded(column) && cards.length" :project="project" :ids="cards.map(({issue}) => issue.id)" :label="look(column).label" />
        <StatusIcon :column="column" />
        <h2 class="text-[13px] font-medium">{{ look(column).label }}</h2>
        <span class="font-mono text-[11px] text-faint tabular-nums">{{ cards.length }}</span>
        <span
            v-if="column === 'proposed' && settings.restrict_proposals"
            class="text-faint"
            title="Only you move these: sessions wait for your approval (App settings → Proposals)"
            aria-label="Only you move proposals"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        </span>
        <UiButton v-if="isClosed(look(column).kind) && cards.length" variant="ghost" size="xs" class="ml-auto" @click="fold(column)">
          {{ folded(column) ? 'Show' : 'Fold' }}
        </UiButton>
      </header>
      <button
          v-if="folded(column)"
          type="button"
          data-nav
          class="flex flex-col items-start gap-1 rounded-xl border border-dashed border-line p-3 text-left text-xs text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent-500/50"
          @click="fold(column)"
      >
        <span class="font-mono text-lg font-medium tabular-nums" :style="{color: look(column).color}">{{ cards.length }}</span>
        {{ cards.length === 1 ? 'issue' : 'issues' }} {{ look(column).label.toLowerCase() }}
      </button>
      <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
        <article
            v-for="{issue, chunk} in cards"
            :key="issue.id"
            data-nav
            :data-issue="issue.id"
            :data-project="project"
            tabindex="0"
            role="button"
            class="group flex cursor-pointer flex-col gap-2 rounded-xl border bg-panel p-3 shadow-sm shadow-black/5 outline-none transition-colors hover:border-faint/40 focus-visible:ring-2 focus-visible:ring-accent-500/50 dark:shadow-black/30"
            :class="[isSelected(project, issue.id) ? 'border-accent-500/60 bg-accent-500/5' : isLast(project, issue.id) ? 'border-faint/50' : 'border-line', issue.waiting ? 'waiting-row' : issueUnseen(project, issue) && 'unseen-row']"
            @click="click($event, issue)"
            @contextmenu="openMenu($event, project, issue.id)"
        >
          <div class="flex items-center gap-2 text-[11px] text-faint">
            <SelectBox :project="project" :id="issue.id" />
            <span v-if="issueUnseen(project, issue)" class="unseen-dot" title="Changed since you last opened it" />
            <span class="font-mono">{{ issue.id }}</span>
            <span class="min-w-0 flex-1 truncate">{{ chunk.title }}</span>
            <PersonAvatar v-if="issue.assignee" :name="issue.assignee" :size="16" />
          </div>
          <div class="flex items-start gap-2">
            <StatusIcon :column="issue.column" :progress="progress(issue.kinds).share" class="mt-0.5" />
            <p class="line-clamp-3 min-w-0 flex-1 text-[13px] leading-snug" :class="[isClosed(issue.kind) ? 'text-muted' : 'text-fg', issueUnseen(project, issue) ? 'font-semibold' : '']"><InlineText :text="issue.title" /></p>
          </div>
          <WaitingChip v-if="issue.waiting" :asks="issue.waiting" :proposal="pendingProposal(issue)" class="self-start" />
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="grid size-5 place-items-center rounded ring-1 ring-line"><PriorityIcon :priority="issue.priority" :size="12" /></span>
            <span v-if="issue.tasks.length" class="flex h-5 items-center gap-1 rounded px-1.5 font-mono text-[10px] text-faint ring-1 ring-line"><ProgressRing :kinds="issue.kinds" bare :size="11" />{{ subs(issue) }}</span>
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
