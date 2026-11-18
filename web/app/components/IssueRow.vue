<script setup lang="ts">
import type {Issue} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// One issue as a row (id, title, labels, status, priority, assignee); a parent shows its
// sub-issues' progress, and with `nested` its sub-issues under it, joined by tree lines. One waiting on others not
// closed yet has a Blocked chip (ORR-601), and one whose change is rated high or medium risk its risk (ORR-879).
// Clicking opens its page (its id is the link, ORR-1280), right-clicking its menu (IssueMenu); `j`/`k` move between rows (`data-nav`). Its tick
// (SelectBox) takes the priority's place on hover, for changing many at once; with any ticked, a shift- or ⌘-click ticks.
//
// The tree: each level is `--indent` (24px) further in, and a sub-issue's line comes down from under its
// parent's first icon (RAIL from the row's edge) and turns into it. `rails` says, for each level
// above the parent, whether that level's line carries on past this row; `last` whether this one does.
//
// On a phone (under `sm`, ORR-1218) the title has the room: it wraps to two lines, the id sits small
// under it rather than in a column of its own, a level is half as far in (`--indent`), and only the
// line from the parent is drawn, not those of the levels above it.
//
// Each thing is said once (ORR-1217): in a group named for a status (`group`, the list's column), a row in it has no
// status chip; waiting on the owner is the row's tint and edge, and a violet dot whose tooltip says which ask; and one
// label shows, the rest as a count.
const {byId} = useRoadmaps()
const props = withDefaults(defineProps<{issue: Issue, project: string, depth?: number, milestone?: {id: string, title: string}, nested?: boolean, rails?: boolean[], last?: boolean, group?: string}>(),
    {depth: 0, milestone: undefined, nested: false, rails: () => [], last: true, group: undefined})
const RAIL = 19
const railAt = (level: number) => `calc(${RAIL}px + ${level} * var(--indent))`
const childRails = computed(() => props.depth ? [...props.rails, !props.last] : [])
const {open, isLast, pathOf} = useIssueLink()
const {open: openMenu} = useIssueMenu()
const {changed} = useRoadmaps()
const {selected, isSelected, toggle} = useSelection()
const ticked = computed(() => isSelected(props.project, props.issue.id))
function click(event: MouseEvent) {
    if (selected.value.length && (event.shiftKey || event.metaKey || event.ctrlKey)) toggle(props.project, props.issue.id, event.shiftKey)
    else open(props.project, props.issue.id)
}
// The id is the row's link (ORR-1280): a real one, which a screen reader and a new tab can reach, rather than the row being a
// button around other controls. A plain click goes on to the row's, which opens it in place (or ticks, with a modifier
// while any are ticked); ⌘-, ctrl- or shift-click with none ticked is the browser's own, a new tab or window.
function linkClick(event: MouseEvent) {
    if (!selected.value.length && (event.metaKey || event.ctrlKey || event.shiftKey)) event.stopPropagation()
    else event.preventDefault()
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
// Its group's header already says it, when the row sits in the column the group is named for.
const saysStatus = computed(() => props.issue.column !== props.group)
const waitingLabel = computed(() => pendingProposal(props.issue) ? 'Proposal: decision needed' : props.issue.waiting === 'decision' ? 'Decision needed' : 'Feedback needed')
</script>

<template>
  <div
      data-nav
      :data-issue="issue.id"
      :data-project="project"
      tabindex="0"
      class="group relative flex min-h-11 items-center gap-3 border-b [--indent:12px] max-sm:py-1.5 sm:h-11 sm:[--indent:24px] border-line/60 pr-3 text-sm outline-none transition-colors hover:bg-hover focus-visible:bg-active"
      :class="[ticked ? 'bg-accent-500/8' : isLast(project, issue.id) ? 'bg-hover' : '', flash ? 'animate-flash' : '', depth ? 'border-b-transparent' : '', issue.waiting ? 'waiting-row' : unseen ? 'unseen-row' : '']"
      :style="{paddingLeft: `calc(12px + ${depth} * var(--indent))`}"
      @click="click"
      @contextmenu="openMenu($event, project, issue.id)"
  >
    <template v-if="depth">
      <template v-for="(carries, level) in rails" :key="level">
        <span v-if="carries" class="pointer-events-none absolute inset-y-0 w-px bg-faint/55 max-sm:hidden" :style="{left: railAt(level)}" />
      </template>
      <span v-if="!last" class="pointer-events-none absolute inset-y-0 w-px bg-faint/55" :style="{left: railAt(depth - 1)}" />
      <span class="pointer-events-none absolute top-0 h-1/2 w-1 rounded-bl-md sm:w-3 border-b border-l border-faint/55" :style="{left: railAt(depth - 1)}" />
    </template>
    <span class="relative hidden size-[14px] shrink-0 sm:block">
      <PriorityIcon :priority="issue.priority" class="transition-opacity" :class="ticked || selected.length ? 'opacity-0' : 'group-hover:opacity-0'" />
      <SelectBox :project="project" :id="issue.id" row class="absolute top-0 left-0" />
    </span>
    <a :href="pathOf(project, issue.id)" tabindex="-1" class="w-16 shrink-0 truncate font-mono text-[11px] text-faint outline-none hover:text-fg max-sm:hidden" :title="`Open ${issue.id}`" @click="linkClick">{{ issue.id }}</a>
    <StatusIcon :column="issue.column" :progress="progress(issue.kinds).share" />
    <span class="flex min-w-0 flex-1 items-center gap-2">
      <span v-if="unseen" class="unseen-dot" title="Changed since you last opened it" />
      <WorkingDot v-if="worker" :session="worker" />
      <span class="flex min-w-0 flex-col">
        <span class="min-w-0 max-sm:line-clamp-2 max-sm:leading-snug sm:truncate" :class="[isClosed(issue.kind) ? 'text-muted' : 'text-fg', unseen ? 'font-semibold' : '']"><InlineText :text="issue.title" /></span>
        <a :href="pathOf(project, issue.id)" tabindex="-1" class="self-start font-mono text-[10px] leading-tight text-faint outline-none sm:hidden" @click="linkClick">{{ issue.id }}</a>
      </span>
      <!-- The row's tint and edge say it waits on the owner; the dot's tooltip says what for. -->
      <span v-if="issue.waiting" class="size-2 shrink-0 rounded-full bg-violet-500" role="img" :aria-label="waitingLabel" :title="waitingLabel" />
      <BlockedChip v-if="issue.blocked_by?.length" :blockers="issue.blocked_by" class="max-sm:hidden" />
      <RiskChip v-if="issue.risk && issue.risk.level !== 'low'" :risk="issue.risk" class="max-sm:hidden" />
      <span v-if="issue.schedule" class="shrink-0 text-faint" title="Made by a schedule"><SectionIcon section="schedules" class="size-3" /></span>
      <span v-if="isParent" class="flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 ring-1 ring-line max-sm:hidden" :title="`${issue.kinds.done} of ${total(issue.kinds)} sub-issues done`"><ProgressRing :kinds="issue.kinds" :size="13" /></span>
    </span>
    <NuxtLink
        v-if="milestone"
        :to="milestonePath(project, milestone.id)"
        class="hidden max-w-40 shrink-0 truncate text-xs text-faint hover:text-fg hover:underline lg:inline"
        :title="`Open ${milestone.id ? milestone.title : 'the issues in no milestone'}`"
        @click.stop
    >{{ milestone.title }}</NuxtLink>
    <span
        v-if="issue.proposal && issue.proposal !== 'pending'"
        class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium ring-1"
        :class="{approved: 'text-emerald-700 ring-emerald-500/30 dark:text-emerald-300', changes: 'text-sky-700 ring-sky-500/30 dark:text-sky-300', rejected: 'text-rose-700 ring-rose-500/30 dark:text-rose-300'}[issue.proposal]"
    >{{ {approved: 'Approved', changes: 'Changes asked', rejected: 'Rejected'}[issue.proposal] }}</span>
    <span class="hidden shrink-0 items-center gap-1 lg:flex">
      <GithubIssueChip v-for="github in issue.github_issues.slice(0, 1)" :key="github" :issue="github" :repo="byId(project)?.repo" />
      <LabelChip v-for="label in issue.labels.slice(0, 1)" :key="label" :label="label" />
      <span v-if="issue.labels.length > 1" class="text-[11px] text-faint" :title="issue.labels.slice(1).join(', ')">+{{ issue.labels.length - 1 }}</span>
    </span>
    <span v-if="issue.comments" class="hidden shrink-0 items-center gap-1 text-[11px] text-faint sm:flex" :title="`${issue.comments} comments`">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>{{ issue.comments }}
    </span>
    <span v-if="saysStatus" class="hidden h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ring-1 ring-line md:inline-flex" :style="{color: readable(look(shown).color)}">{{ look(shown).label }}</span>
    <ClaimMark :issue="issue" />
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
        :group="group"
        nested
    />
  </template>
</template>
