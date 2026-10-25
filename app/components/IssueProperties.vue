<script setup lang="ts">
import type {Chunk, Column, Issue, Project} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

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
const chunks = computed(() => props.project.board.chunks.filter(c => c.id))
const statusOptions = computed(() => places.value.map(p => ({value: p.id, label: p.label})))
const priorityOptions = [{value: '', label: 'No priority'}, ...PRIORITIES.map(p => ({value: p, label: `${p} · ${PRIORITY_LABEL[p]}`}))]
const chunkOptions = computed(() => [{value: '', label: 'No chunk'}, ...chunks.value.map(c => ({value: c.id, label: c.title}))])

// Labels: any the project uses, or a new one.
const known = computed(() => [...new Set(allIssues(props.project).flatMap(({issue}) => issue.labels))])
const labels = computed({
    get: () => props.issue.labels,
    set: (next: string[]) => save({labels: next}),
})

const labelOptions = computed(() => [...new Set([...known.value, ...props.issue.labels])].sort((a, b) => a.localeCompare(b)).map(l => ({value: l, label: l})))

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
      <PropertyPicker v-model="priority" :options="priorityOptions" label="Priority" :disabled="saving">
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

    <dt class="label">Project</dt>
    <dd><NuxtLink :to="`/p/${project.id}`" class="hover:underline">{{ project.name }}</NuxtLink></dd>

    <dt class="label">Chunk</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <PropertyPicker v-if="!isSub" v-model="chunkId" :options="chunkOptions" label="Chunk" :disabled="saving">
        <span class="truncate" :class="!chunk.id && 'text-faint'">{{ chunk.id ? chunk.title : 'No chunk' }}</span>
      </PropertyPicker>
      <NuxtLink v-else :to="chunkPath(project.id, chunk.id)" class="truncate hover:underline" :class="!chunk.id && 'text-faint'" title="A sub-issue is in its parent's chunk">{{ chunk.title }}</NuxtLink>
      <NuxtLink v-if="!isSub && chunk.id" :to="chunkPath(project.id, chunk.id)" class="shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-fg" title="Open the chunk" aria-label="Open the chunk">
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
      </NuxtLink>
    </dd>

    <template v-if="hasSubs">
      <dt class="label">Progress</dt>
      <dd class="flex items-center gap-3"><ProgressRing :kinds="issue.kinds" /><ColumnBar :counts="issue.counts" class="max-w-32" /></dd>
    </template>
    <dt class="label">Created by</dt>
    <dd class="flex flex-wrap items-center gap-x-2 text-muted">
      {{ who(issue.createdBy) }}
      <span v-if="issue.protected" class="flex items-center gap-1 text-xs text-faint" title="Only the owner can delete it">
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        protected
      </span>
    </dd>
    <dt class="label">Created</dt>
    <dd class="text-muted" :title="issue.createdAt">{{ ago(issue.createdAt) }}</dd>
    <dt class="label">Updated</dt>
    <dd class="text-muted" :title="issue.updatedAt">{{ ago(issue.updatedAt) }}</dd>
    <dd v-if="failed" class="col-span-2 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</dd>
  </dl>
</template>
