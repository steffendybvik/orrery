<script setup lang="ts">
import type {Chunk, Column, Issue} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// Issues as cards in their columns, started first and closed last. A parent stands for its
// sub-issues. One waiting on others stays in its column, with a Blocked chip (ORR-601). A status the filter leaves
// out has no column, unless a card is in it (a parent kept for a sub-issue that matches). Closed columns start folded to a count. Right-clicking a card opens its menu (IssueMenu). An unfolded
// column's header has a tick (GroupTick) for all its cards.
// A card dragged to another column (a folded one too) moves there, as the menu's move does, and so do the other ticked
// cards when it's ticked; [ and ] move the focused card (or the ticked ones) one column left or right. While
// proposals are restricted, nothing is dragged into Proposed or out of it: approving one stays a deliberate act.
const props = defineProps<{chunks: Chunk[], project: string}>()
const {open, isLast} = useIssueLink()
const {issueUnseen} = useUnseen()
const {workerOf} = useWorkedIssues()
const {open: openMenu} = useIssueMenu()
const {columns: order, look} = useStatuses()
const {selected, isSelected, toggle} = useSelection()
const {settings} = useAppSettings()
const {filters} = useFilters()
const {load} = useOwner()
function click(event: MouseEvent, issue: Issue) {
    if (selected.value.length && (event.shiftKey || event.metaKey || event.ctrlKey)) toggle(props.project, issue.id, event.shiftKey)
    else open(props.project, issue.id)
}
const unfolded = ref<Column[]>([])
const dragging = ref<Issue[]>([])
/** A column the dragged cards can't go to, other than one they're in: dimmed while they're dragged. */
const refused = (column: Column) => !!dragging.value.length && !takes(dragging.value, column) && !dragging.value.some(i => i.column === column)

const columns = computed(() => {
    const issues = props.chunks.flatMap(chunk => chunk.tasks.map(issue => ({issue, chunk})))
    const picked = filters.value.columns
    return order.value.map(({id}) => ({column: id, cards: issues.filter(({issue}) => issue.column === id)}))
        .map(c => ({...c, shown: !picked.length || picked.includes(c.column) || !!c.cards.length}))
})
// The filter's hidden columns (Done and Canceled, to begin with) show as places to drop while a card is dragged.
const placed = computed(() => columns.value.filter(c => c.shown || takes(dragging.value, c.column)))
const folded = (column: Column) => isClosed(look(column).kind) && !unfolded.value.includes(column)
const fold = (column: Column) => unfolded.value = unfolded.value.includes(column) ? unfolded.value.filter(c => c !== column) : [...unfolded.value, column]
const subs = (issue: Issue) => `${issue.kinds.done}/${total(issue.kinds)}`

const locked = (column: Column) => column === 'proposed' && !!settings.value.restrict_proposals
/** What moving this card moves: every ticked card on the board when it's ticked, else itself. */
function movesOf(issue: Issue): Issue[] {
    if (!isSelected(props.project, issue.id)) return [issue]
    return placed.value.flatMap(({cards}) => cards.map(c => c.issue)).filter(i => isSelected(props.project, i.id))
}
/** Whether these cards can go to the column: not into or out of a locked one, and not all there already. */
const takes = (issues: Issue[], column: Column) => !!issues.length && !locked(column) && !issues.some(i => locked(i.column)) && issues.some(i => i.column !== column)

const over = ref<Column | null>(null)
const failed = ref('')
// The card moved by a key, focused again once it shows in its new column.
const refocus = ref<string | null>(null)

function onDragStart(event: DragEvent, issue: Issue) {
    dragging.value = movesOf(issue)
    event.dataTransfer?.setData('text/plain', issue.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragOver(event: DragEvent, column: Column) {
    if (!takes(dragging.value, column)) return
    event.preventDefault()
    over.value = column
}
function onDragLeave(event: DragEvent, column: Column) {
    if (over.value === column && !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) over.value = null
}
function onDragEnd() {
    dragging.value = []
    over.value = null
}
function onDrop(column: Column) {
    const issues = dragging.value
    onDragEnd()
    if (takes(issues, column)) move(issues, column)
}
function onStep(event: KeyboardEvent, issue: Issue) {
    const by = event.key === ']' ? 1 : event.key === '[' ? -1 : 0
    if (!by || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    const issues = movesOf(issue)
    const order = placed.value.map(c => c.column)
    let at = order.indexOf(issue.column) + by
    let to = order[at]
    while (to && !takes(issues, to)) to = order[at += by]
    if (!to) return
    refocus.value = issue.id
    move(issues, to)
}

/** Each card to the column, as the owner; the board updates live once they're saved. */
async function move(issues: Issue[], column: Column) {
    failed.value = ''
    const actor = await load()
    const results = await Promise.allSettled(issues.filter(i => i.column !== column).map(issue =>
        $fetch(`/api/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(issue.id)}`, {method: 'PATCH', headers: {'Orrery-Actor': actor}, body: columnPatch(column, issue.proposal)})
            .catch(error => Promise.reject(new Error(`${issue.id}: ${errorMessage(error)}`)))))
    const why = results.flatMap(r => r.status === 'rejected' ? [(r.reason as Error).message] : [])
    if (why.length) failed.value = `Couldn't move ${why.join('; ')}`
}
watch(columns, () => {
    const el = refocus.value && document.querySelector<HTMLElement>(`main [data-project="${CSS.escape(props.project)}"][data-issue="${CSS.escape(refocus.value)}"]`)
    if (!el || el.matches(':focus')) return
    el.focus({preventScroll: true})
    el.scrollIntoView({block: 'nearest', inline: 'nearest'})
    refocus.value = null
}, {flush: 'post'})
</script>

<template>
  <div class="flex h-full snap-x scroll-px-3 gap-3 overflow-x-auto p-3 sm:scroll-px-4 sm:p-4">
    <section
        v-for="{column, cards, shown} in placed"
        :key="column"
        class="flex shrink-0 snap-start flex-col rounded-xl transition-[opacity,background-color]"
        :class="[folded(column) || !shown ? 'w-44' : 'w-[85vw] sm:w-80', over === column ? 'bg-accent-500/5 ring-2 ring-accent-500/40' : refused(column) && 'opacity-50']"
        :data-column="column"
        @dragover="onDragOver($event, column)"
        @dragleave="onDragLeave($event, column)"
        @drop.prevent="onDrop(column)"
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
      <div
          v-if="!shown"
          class="flex flex-1 items-start rounded-xl border border-dashed border-accent-500/40 p-3 text-xs text-muted"
      >
        Drop to move to {{ look(column).label }}
      </div>
      <button
          v-else-if="folded(column)"
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
            :draggable="!locked(issue.column)"
            class="group flex flex-col gap-2 rounded-xl border bg-panel p-3 shadow-sm shadow-black/5 outline-none transition-colors hover:border-faint/40 focus-visible:ring-2 focus-visible:ring-accent-500/50 dark:shadow-black/30"
            :class="[dragging.some(i => i.id === issue.id) && 'opacity-40', isSelected(project, issue.id) ? 'border-accent-500/60 bg-accent-500/5' : isLast(project, issue.id) ? 'border-faint/50' : 'border-line', issue.waiting ? 'waiting-row' : issueUnseen(project, issue) && 'unseen-row']"
            @click="click($event, issue)"
            @contextmenu="openMenu($event, project, issue.id)"
            @dragstart="onDragStart($event, issue)"
            @dragend="onDragEnd"
            @keydown="onStep($event, issue)"
        >
          <div class="flex items-center gap-2 text-[11px] text-faint">
            <SelectBox :project="project" :id="issue.id" />
            <span v-if="issueUnseen(project, issue)" class="unseen-dot" title="Changed since you last opened it" />
            <span class="font-mono">{{ issue.id }}</span>
            <span class="min-w-0 flex-1 truncate">{{ chunk.title }}</span>
            <WorkingDot v-if="!isClosed(issue.kind) && workerOf(project, issue.id)" :session="workerOf(project, issue.id)!" />
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
            <BlockedChip v-if="issue.blocked_by?.length" :blockers="issue.blocked_by" />
            <LabelChip v-for="label in issue.labels.slice(0, 3)" :key="label" :label="label" />
            <span v-if="issue.comments" class="ml-auto flex items-center gap-1 text-[11px] text-faint">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>{{ issue.comments }}
            </span>
          </div>
        </article>
        <div v-if="!cards.length" class="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-faint">Nothing here</div>
      </div>
    </section>
    <p v-if="failed" role="alert" class="fixed bottom-4 left-1/2 z-30 max-w-[90vw] -translate-x-1/2 rounded-lg bg-panel px-3 py-2 text-xs text-rose-600 shadow-lg ring-1 ring-line dark:text-rose-400" @click="failed = ''">{{ failed }}</p>
  </div>
</template>
