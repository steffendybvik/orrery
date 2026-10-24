<script setup lang="ts">
import type {Issue} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// One issue as a row (id, title, labels, status, column, priority, assignee); a parent shows its
// sub-issues' progress, and with `nested` its sub-issues under it, joined by tree lines as in Linear.
// Clicking opens its page, right-clicking its menu (IssueMenu); `j`/`k` move between rows (`data-nav`).
//
// The tree: each level is INDENT further in, and a sub-issue's line comes down from under its
// parent's first icon (RAIL from the row's edge) and turns into it. `rails` says, for each level
// above the parent, whether that level's line carries on past this row; `last` whether this one does.
const props = withDefaults(defineProps<{issue: Issue, project: string, depth?: number, chunk?: string, nested?: boolean, rails?: boolean[], last?: boolean}>(),
    {depth: 0, chunk: undefined, nested: false, rails: () => [], last: true})
const INDENT = 24
const RAIL = 19
const railAt = (level: number) => `${RAIL + level * INDENT}px`
const childRails = computed(() => props.depth ? [...props.rails, !props.last] : [])
const {open, isLast} = useIssueLink()
const {open: openMenu} = useIssueMenu()
const {changed} = useRoadmaps()

const isParent = computed(() => props.issue.tasks.length > 0)
const flash = computed(() => Date.now() - (changed.value[`${props.project}/${props.issue.id}`] ?? 0) < 1500)
const STATUS_PILL = {
    todo: 'text-muted ring-line',
    doing: 'text-accent-600 ring-accent-500/40 bg-accent-500/10 dark:text-accent-300',
    done: 'text-emerald-600 ring-emerald-500/30 bg-emerald-500/10 dark:text-emerald-300',
}
</script>

<template>
  <div
      data-nav
      :data-issue="issue.id"
      tabindex="0"
      role="button"
      class="group relative flex h-11 cursor-pointer items-center gap-3 border-b border-line/60 pr-3 text-sm outline-none transition-colors hover:bg-hover focus-visible:bg-active"
      :class="[isLast(project, issue.id) ? 'bg-hover' : '', flash ? 'animate-flash' : '', depth ? 'border-b-transparent' : '']"
      :style="{paddingLeft: `${12 + depth * INDENT}px`}"
      @click="open(project, issue.id)"
      @contextmenu="openMenu($event, project, issue.id)"
  >
    <template v-if="depth">
      <template v-for="(carries, level) in rails" :key="level">
        <span v-if="carries" class="pointer-events-none absolute inset-y-0 w-px bg-faint/55" :style="{left: railAt(level)}" />
      </template>
      <span v-if="!last" class="pointer-events-none absolute inset-y-0 w-px bg-faint/55" :style="{left: railAt(depth - 1)}" />
      <span class="pointer-events-none absolute top-0 h-1/2 w-3 rounded-bl-md border-b border-l border-faint/55" :style="{left: railAt(depth - 1)}" />
    </template>
    <PriorityIcon :priority="issue.priority" class="hidden sm:block" />
    <span class="w-16 shrink-0 truncate font-mono text-[11px] text-faint">{{ issue.id }}</span>
    <StatusIcon :column="issue.column" :progress="progress(issue.counts).share" />
    <span class="flex min-w-0 flex-1 items-center gap-2">
      <span class="min-w-0 truncate" :class="issue.column === 'done' ? 'text-muted' : 'text-fg'"><InlineText :text="issue.title" /></span>
      <span v-if="isParent" class="flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 ring-1 ring-line" :title="`${issue.counts.done} of ${total(issue.counts)} sub-issues done`"><ProgressRing :counts="issue.counts" :size="13" /></span>
    </span>
    <span v-if="chunk" class="hidden max-w-40 shrink-0 truncate text-xs text-faint lg:inline">{{ chunk }}</span>
    <span class="hidden shrink-0 items-center gap-1 lg:flex">
      <LabelChip v-for="label in issue.labels.slice(0, 2)" :key="label" :label="label" />
      <span v-if="issue.labels.length > 2" class="text-[11px] text-faint">+{{ issue.labels.length - 2 }}</span>
    </span>
    <span v-if="issue.comments" class="hidden shrink-0 items-center gap-1 text-[11px] text-faint sm:flex" :title="`${issue.comments} comments`">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>{{ issue.comments }}
    </span>
    <span v-if="!isParent" class="hidden h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium capitalize ring-1 md:inline-flex" :class="STATUS_PILL[issue.status]">{{ issue.status }}</span>
    <span class="hidden w-14 shrink-0 text-right text-xs md:inline" :class="COLUMN_STYLE[issue.column].text">{{ COLUMN_STYLE[issue.column].label }}</span>
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
