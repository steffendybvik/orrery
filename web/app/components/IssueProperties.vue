<script setup lang="ts">
import type {Chunk, Column, Issue, Project} from '#shared/roadmap'
import {isFrozen, taskUrl} from '#shared/roadmap'

// An issue's properties, as the right-hand column of its page: status, priority, assignee, labels and
// chunk are menus to type in (`PropertyPicker`), and change in place, as the owner, saving at once.
/** `sub`: it's a sub-issue, in its parent's chunk. */
const props = defineProps<{issue: Issue, project: Project, chunk: Chunk, sub?: boolean}>()
const {who, name: owner} = useOwner()
const {save, saving, failed} = useIssueSave(() => props.project.id, () => props.issue.id)

// A parent's status follows its sub-issues, and a sub-issue is in its parent's chunk.
const hasSubs = computed(() => props.issue.tasks.length > 0)
const isSub = computed(() => !!props.sub)

const {places} = useStatuses()
const column = computed({
    get: () => props.issue.column,
    set: (next: Column) => save(columnPatch(next, props.issue.proposal)),
})
const priority = computed({
    get: () => props.issue.priority ?? '',
    set: (next: string) => save({priority: next || null}),
})
const chunkId = computed({
    get: () => props.chunk.id,
    set: (next: string) => save({chunk: next || null}),
})
const statusOptions = computed(() => places.value.map(p => ({value: p.id, label: p.label})))
// The release it ships in, newest first; a shipped or frozen one says so.
const release = computed({
    get: () => props.issue.release ?? '',
    set: (next: string) => save({release: next || null}),
})
const releaseOptions = computed(() => [{value: '', label: 'No release'}, ...props.project.releases.map(r => ({value: r.version, label: r.shipped_on ? `${r.version} · shipped` : isFrozen(r) ? `${r.version} · frozen` : r.version}))])
// Only a heads-up: a frozen release still takes the issue.
const frozen = computed(() => isFrozen(props.project.releases.find(r => r.version === props.issue.release)))

// Labels: any the project uses, or a new one.
const known = computed(() => [...new Set(allIssues(props.project).flatMap(({issue}) => issue.labels))])
const labels = computed({
    get: () => props.issue.labels,
    set: (next: string[]) => save({labels: next}),
})

const labelOptions = computed(() => [...new Set([...known.value, ...props.issue.labels])].sort((a, b) => a.localeCompare(b)).map(l => ({value: l, label: l})))

// Its tasks on the team's tracker: any the project links, or a new id; each opens through the tracker's pattern.
const {settings} = useAppSettings()
const knownTasks = computed(() => [...new Set(allIssues(props.project).flatMap(({issue}) => issue.external))])
const tasks = computed({
    get: () => props.issue.external,
    set: (next: string[]) => save({external: next}),
})
const taskOptions = computed(() => [...new Set([...knownTasks.value, ...props.issue.external])].sort((a, b) => a.localeCompare(b)).map(t => ({value: t, label: t})))
const taskLinks = computed(() => props.issue.external.map(t => ({task: t, url: taskUrl(settings.value.tracker, t)})))

// The assignee: the owner, an agent, anyone already assigned in the project, or a new name.
const people = computed(() => [...new Set([owner.value, 'claude', ...allIssues(props.project).map(({issue}) => issue.assignee)].filter((n): n is string => !!n))])
const assignee = computed({
    get: () => props.issue.assignee ?? '',
    set: (next: string) => save({assignee: next.trim() || null}),
})
const assigneeOptions = computed(() => [{value: '', label: 'Unassigned'}, ...people.value.map(p => ({value: p, label: who(p)}))])
</script>

<template>
  <dl class="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
    <dt class="label">Status</dt>
    <dd class="flex min-w-0 flex-col">
      <PropertyPicker v-model="column" :options="statusOptions" label="Status" :disabled="hasSubs || saving">
        <StatusIcon :column="issue.column" :progress="progress(issue.kinds).share" />
        <span class="truncate">{{ statusOptions.find(o => o.value === issue.column)?.label ?? issue.column }}</span>
        <template #option="{option}">
          <StatusIcon :column="option.value" />
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
        </template>
      </PropertyPicker>
      <span v-if="hasSubs" class="text-xs text-faint">from its sub-issues</span>
    </dd>

    <dt class="label">Priority</dt>
    <dd class="flex min-w-0">
      <PropertyPicker v-model="priority" :options="PRIORITY_OPTIONS" label="Priority" :disabled="saving">
        <PriorityIcon :priority="issue.priority" />
        <span class="truncate" :class="!issue.priority && 'text-faint'">{{ issue.priority ? `${issue.priority} · ${PRIORITY_LABEL[issue.priority]}` : 'No priority' }}</span>
        <template #option="{option}">
          <PriorityIcon :priority="option.value || undefined" />
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
        </template>
      </PropertyPicker>
    </dd>

    <dt class="label">Assignee</dt>
    <dd class="flex min-w-0">
      <PropertyPicker v-model="assignee" :options="assigneeOptions" label="Assignee" placeholder="Find or assign someone…" creatable create-verb="Assign" :disabled="saving">
        <PersonAvatar v-if="issue.assignee" :name="issue.assignee" />
        <span class="truncate" :class="!issue.assignee && 'text-faint'" :title="issue.assignee ?? undefined">{{ issue.assignee ? who(issue.assignee) : 'Unassigned' }}</span>
        <template #option="{option}">
          <PersonAvatar v-if="option.value" :name="option.value" />
          <span v-else class="size-[18px] shrink-0 rounded-full border border-dashed border-faint/60" />
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
        </template>
      </PropertyPicker>
    </dd>

    <dt class="label">Labels</dt>
    <dd class="flex min-w-0">
      <PropertyPicker v-model="labels" :options="labelOptions" label="Labels" placeholder="Find or add a label…" multiple creatable :disabled="saving">
        <span v-if="issue.labels.length" class="flex min-w-0 flex-wrap items-center gap-1">
          <LabelChip v-for="l in issue.labels" :key="l" :label="l" />
        </span>
        <span v-else class="text-faint">No labels</span>
        <template #option="{option}"><LabelChip :label="option.value" /></template>
      </PropertyPicker>
    </dd>

    <dt class="label">Team tasks</dt>
    <dd class="flex min-w-0 flex-wrap items-center gap-1">
      <span v-if="taskLinks.length" class="flex min-w-0 flex-wrap gap-1">
        <component
            :is="link.url ? 'a' : 'span'"
            v-for="link in taskLinks"
            :key="link.task"
            :href="link.url"
            target="_blank"
            rel="noopener"
            class="max-w-full truncate rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-line"
            :class="link.url ? 'text-accent-600 hover:bg-hover dark:text-accent-400' : 'text-muted'"
            :title="link.url ? `Open ${link.task} on the team's tracker` : 'Set the tracker in App settings to link it'"
        >{{ link.task }}</component>
      </span>
      <PropertyPicker v-model="tasks" :options="taskOptions" label="Team tasks" placeholder="Add a task id, e.g. ENG-1567…" multiple creatable :disabled="saving">
        <span class="text-faint">{{ issue.external.length ? 'Edit' : 'None' }}</span>
      </PropertyPicker>
    </dd>

    <dt class="label">Project</dt>
    <dd><NuxtLink :to="`/p/${project.id}`" class="hover:underline">{{ project.name }}</NuxtLink></dd>

    <dt class="label">Chunk</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <PropertyPicker v-if="!isSub" v-model="chunkId" :options="chunkOptions(project.board.chunks)" label="Chunk" :disabled="saving">
        <span class="truncate" :class="!chunk.id && 'text-faint'">{{ chunk.id ? chunk.title : 'No chunk' }}</span>
      </PropertyPicker>
      <NuxtLink v-else :to="chunkPath(project.id, chunk.id)" class="truncate hover:underline" :class="!chunk.id && 'text-faint'" title="A sub-issue is in its parent's chunk">{{ chunk.title }}</NuxtLink>
      <UiButton v-if="!isSub && chunk.id" :to="chunkPath(project.id, chunk.id)" variant="ghost" size="xs" square class="shrink-0" title="Open the chunk" aria-label="Open the chunk">
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
      </UiButton>
    </dd>

    <template v-if="project.releases.length || issue.release">
      <dt class="label">Release</dt>
      <dd class="flex min-w-0 items-center gap-1">
        <PropertyPicker v-model="release" :options="releaseOptions" label="Release" :disabled="saving">
          <span class="truncate font-mono text-xs" :class="!issue.release && 'font-sans text-faint'">{{ issue.release ?? 'No release' }}</span>
        </PropertyPicker>
        <UiButton v-if="issue.release" :to="releasePath(project.id, issue.release)" variant="ghost" size="xs" square class="shrink-0" title="Open the release" aria-label="Open the release">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
        </UiButton>
      </dd>
      <dd v-if="frozen" class="col-start-2 -mt-1 text-xs text-faint">Frozen: fixes, tests and docs. A new feature fits the next release.</dd>
    </template>

    <template v-if="hasSubs">
      <dt class="label">Progress</dt>
      <dd class="flex items-center gap-3"><ProgressRing :kinds="issue.kinds" /><ColumnBar :counts="issue.counts" class="max-w-32" /></dd>
    </template>
    <dt class="label">Created by</dt>
    <dd class="flex flex-wrap items-center gap-x-2 text-muted">
      {{ who(issue.created_by, issue.session_name) }}
      <span v-if="issue.protected" class="flex items-center gap-1 text-xs text-faint" title="Only the owner can delete it">
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        protected
      </span>
    </dd>
    <dt class="label">Created</dt>
    <dd class="text-muted" :title="issue.created_at">{{ ago(issue.created_at) }}</dd>
    <dt class="label">Updated</dt>
    <dd class="text-muted" :title="issue.updated_at">{{ ago(issue.updated_at) }}</dd>
    <dd v-if="failed" class="col-span-2 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</dd>
  </dl>
</template>
