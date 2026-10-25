<script setup lang="ts">
import type {Chunk, Column, Issue, Project} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// An issue's properties, as the right-hand column of its page: status, priority, assignee, labels and
// chunk change in place, as the owner, and save at once.
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

// Labels: any the project uses, or a new one.
const known = computed(() => [...new Set(allIssues(props.project).flatMap(({issue}) => issue.labels))])
const labels = computed({
    get: () => props.issue.labels,
    set: (next: string[]) => save({labels: next}),
})

// The assignee: the owner, an agent, or anyone already assigned in the project. Saved on Enter or leaving it.
const assignee = ref('')
watch(() => props.issue.assignee, now => {
    assignee.value = now ?? ''
}, {immediate: true})
const people = computed(() => [...new Set([owner.value, 'claude', ...allIssues(props.project).map(({issue}) => issue.assignee)].filter((n): n is string => !!n))])
async function saveAssignee() {
    const next = assignee.value.trim()
    if (next === (props.issue.assignee ?? '')) return
    if (!await save({assignee: next || null})) assignee.value = props.issue.assignee ?? ''
}

const field = 'h-7 w-full min-w-0 cursor-pointer rounded-md bg-transparent px-1.5 -ml-1.5 text-[13px] text-fg hover:bg-hover focus:bg-hover focus:outline-none disabled:cursor-default disabled:hover:bg-transparent'
</script>

<template>
  <dl class="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
    <dt class="label">Status</dt>
    <dd class="flex min-w-0 flex-col">
      <label class="flex items-center gap-2">
        <StatusIcon :column="issue.column" :progress="progress(issue.kinds).share" />
        <select v-model="column" :class="field" :disabled="hasSubs || saving" aria-label="Status">
          <option v-for="place in places" :key="place.id" :value="place.id">{{ place.label }}</option>
        </select>
      </label>
      <span v-if="hasSubs" class="text-xs text-faint">from its sub-issues</span>
    </dd>

    <dt class="label">Priority</dt>
    <dd>
      <label class="flex items-center gap-2">
        <PriorityIcon :priority="issue.priority" />
        <select v-model="priority" :class="field" :disabled="saving" aria-label="Priority">
          <option value="">No priority</option>
          <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }} · {{ PRIORITY_LABEL[p] }}</option>
        </select>
      </label>
    </dd>

    <dt class="label">Assignee</dt>
    <dd class="flex items-center gap-2">
      <PersonAvatar v-if="issue.assignee" :name="issue.assignee" />
      <input
          v-model="assignee"
          :class="[field, 'cursor-text']"
          placeholder="Unassigned"
          :title="issue.assignee ? who(issue.assignee) : 'Unassigned'"
          list="issue-people"
          aria-label="Assignee"
          spellcheck="false"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          @keydown.esc="assignee = issue.assignee ?? ''; ($event.target as HTMLInputElement).blur()"
          @blur="saveAssignee"
      >
      <datalist id="issue-people">
        <option v-for="person in people" :key="person" :value="person">{{ who(person) }}</option>
      </datalist>
    </dd>

    <dt class="label">Labels</dt>
    <dd class="flex min-w-0 flex-wrap items-center gap-1">
      <LabelPicker v-model="labels" :labels="known" />
    </dd>

    <dt class="label">Project</dt>
    <dd><NuxtLink :to="`/p/${project.id}`" class="hover:underline">{{ project.name }}</NuxtLink></dd>

    <dt class="label">Chunk</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <select v-if="!isSub" v-model="chunkId" :class="field" :disabled="saving" aria-label="Chunk">
        <option value="">No chunk</option>
        <option v-for="c in chunks" :key="c.id" :value="c.id">{{ c.title }}</option>
      </select>
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
