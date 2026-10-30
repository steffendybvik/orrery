<script setup lang="ts">
import type {Issue} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// One issue as a row (id, title, labels, status, priority, assignee); a parent shows its
// sub-issues' progress, and with `nested` its sub-issues under it, joined by tree lines. One waiting on others not
// closed yet has a Blocked chip (ORR-601).
// Clicking opens its page, right-clicking its menu (IssueMenu); `j`/`k` move between rows (`data-nav`). Its tick
// (SelectBox) takes the priority's place on hover, for changing many at once; with any ticked, a shift- or ⌘-click ticks.
//
// The tree: each level is INDENT further in, and a sub-issue's line comes down from under its
// parent's first icon (RAIL from the row's edge) and turns into it. `rails` says, for each level
// above the parent, whether that level's line carries on past this row; `last` whether this one does.
const props = withDefaults(defineProps<{issue: Issue, project: string, depth?: number, chunk?: {id: string, title: string}, nested?: boolean, rails?: boolean[], last?: boolean}>(),
    {depth: 0, chunk: undefined, nested: false, rails: () => [], last: true})
const INDENT = 24
const RAIL = 19
const railAt = (level: number) => `${RAIL + level * INDENT}px`
const childRails = computed(() => props.depth ? [...props.rails, !props.last] : [])
const {open, isLast} = useIssueLink()
const {open: openMenu} = useIssueMenu()
const {changed} = useRoadmaps()
const {selected, isSelected, toggle} = useSelection()
const ticked = computed(() => isSelected(props.project, props.issue.id))
function click(event: MouseEvent) {
    if (selected.value.length && (event.shiftKey || event.metaKey || event.ctrlKey)) toggle(props.project, props.issue.id, event.shiftKey)
    else open(props.project, props.issue.id)
}

const isParent = computed(() => props.issue.tasks.length > 0)
const flash = computed(() => Date.now() - (changed.value[`${props.project}/${props.issue.id}`] ?? 0) < 1500)
const {issueUnseen} = useUnseen()
const unseen = computed(() => issueUnseen(props.project, props.issue))
const {workerOf} = useWorkedIssues()
const worker = computed(() => isClosed(props.issue.kind) ? undefined : workerOf(props.project, props.issue.id))
const {look} = useStatuses()
// The status in words once: the issue's own, or for a parent the column its sub-issues put it in.
const shown = computed(() => isParent.value ? props.issue.column : props.issue.status)
</script>

<template>
  <div
      data-nav
      :data-issue="issue.id"
      :data-project="project"
      tabindex="0"
      role="button"
      class="group relative flex h-11 items-center gap-3 border-b border-line/60 pr-3 text-sm outline-none transition-colors hover:bg-hover focus-visible:bg-active"
      :class="[ticked ? 'bg-accent-500/8' : isLast(project, issue.id) ? 'bg-hover' : '', flash ? 'animate-flash' : '', depth ? 'border-b-transparent' : '', issue.waiting ? 'waiting-row' : unseen ? 'unseen-row' : '']"
      :style="{paddingLeft: `${12 + depth * INDENT}px`}"
      @click="click"
      @contextmenu="openMenu($event, project, issue.id)"
  >
    <template v-if="depth">
      <template v-for="(carries, level) in rails" :key="level">
        <span v-if="carries" class="pointer-events-none absolute inset-y-0 w-px bg-faint/55" :style="{left: railAt(level)}" />
      </template>
      <span v-if="!last" class="pointer-events-none absolute inset-y-0 w-px bg-faint/55" :style="{left: railAt(depth - 1)}" />
      <span class="pointer-events-none absolute top-0 h-1/2 w-3 rounded-bl-md border-b border-l border-faint/55" :style="{left: railAt(depth - 1)}" />
    </template>
    <span class="relative hidden size-[14px] shrink-0 sm:block">
      <PriorityIcon :priority="issue.priority" class="transition-opacity" :class="ticked || selected.length ? 'opacity-0' : 'group-hover:opacity-0'" />
      <SelectBox :project="project" :id="issue.id" row class="absolute top-0 left-0" />
    </span>
    <span class="w-16 shrink-0 truncate font-mono text-[11px] text-faint">{{ issue.id }}</span>
    <StatusIcon :column="issue.column" :progress="progress(issue.kinds).share" />
    <span class="flex min-w-0 flex-1 items-center gap-2">
      <span v-if="unseen" class="unseen-dot" title="Changed since you last opened it" />
      <WorkingDot v-if="worker" :session="worker" />
      <span class="min-w-0 truncate" :class="[isClosed(issue.kind) ? 'text-muted' : 'text-fg', unseen ? 'font-semibold' : '']"><InlineText :text="issue.title" /></span>
      <template v-if="issue.waiting">
        <WaitingChip :asks="issue.waiting" :proposal="pendingProposal(issue)" class="max-sm:hidden" />
        <!-- On a phone the title needs the room: the chip's dot alone, the row tinted as ever. -->
        <span class="size-2 shrink-0 rounded-full bg-violet-500 sm:hidden" role="img" :aria-label="issue.waiting === 'decision' ? 'Decision needed' : 'Feedback needed'" :title="issue.waiting === 'decision' ? 'Decision needed' : 'Feedback needed'" />
      </template>
      <BlockedChip v-if="issue.blocked_by?.length" :blockers="issue.blocked_by" class="max-sm:hidden" />
      <span v-if="issue.schedule" class="shrink-0 text-faint" title="Made by a schedule"><SectionIcon section="schedules" class="size-3" /></span>
      <span v-if="isParent" class="flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 ring-1 ring-line max-sm:hidden" :title="`${issue.kinds.done} of ${total(issue.kinds)} sub-issues done`"><ProgressRing :kinds="issue.kinds" :size="13" /></span>
    </span>
    <NuxtLink
        v-if="chunk"
        :to="chunkPath(project, chunk.id)"
        class="hidden max-w-40 shrink-0 truncate text-xs text-faint hover:text-fg hover:underline lg:inline"
        :title="`Open ${chunk.id ? chunk.title : 'the issues in no chunk'}`"
        @click.stop
    >{{ chunk.title }}</NuxtLink>
    <span
        v-if="issue.proposal && issue.proposal !== 'pending'"
        class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium ring-1"
        :class="{approved: 'text-emerald-700 ring-emerald-500/30 dark:text-emerald-300', changes: 'text-sky-700 ring-sky-500/30 dark:text-sky-300', rejected: 'text-rose-700 ring-rose-500/30 dark:text-rose-300'}[issue.proposal]"
    >{{ {approved: 'Approved', changes: 'Changes asked', rejected: 'Rejected'}[issue.proposal] }}</span>
    <span class="hidden shrink-0 items-center gap-1 lg:flex">
      <LabelChip v-for="label in issue.labels.slice(0, 2)" :key="label" :label="label" />
      <span v-if="issue.labels.length > 2" class="text-[11px] text-faint">+{{ issue.labels.length - 2 }}</span>
    </span>
    <span v-if="issue.comments" class="hidden shrink-0 items-center gap-1 text-[11px] text-faint sm:flex" :title="`${issue.comments} comments`">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>{{ issue.comments }}
    </span>
    <span class="hidden h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ring-1 ring-line md:inline-flex" :style="{color: look(shown).color}">{{ look(shown).label }}</span>
    <PersonAvatar v-if="issue.assignee" :name="issue.assignee" />
    <span v-else class="size-[18px] shrink-0 rounded-full border border-dashed border-faint/50" title="No assignee" />
  </div>
  <template v-if="nested">
    <IssueRow
        v-for="(sub, i) in issue.tasks"
        :key="sub.id"
        :issue="sub"
        :project="project"
        :depth="depth + 1"
        :rails="childRails"
        :last="i === issue.tasks.length - 1"
        nested
    />
  </template>
</template>
