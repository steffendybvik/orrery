<script setup lang="ts">
import type {Chunk, Issue, Project} from '#shared/roadmap'

// An issue's properties, as the right-hand column of its page.
defineProps<{issue: Issue, project: Project, chunk: Chunk}>()
</script>

<template>
  <dl class="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3 text-[13px]">
    <dt class="label">Status</dt>
    <dd class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <StatusIcon :column="issue.column" :progress="progress(issue.counts).share" />
      <span>{{ COLUMN_STYLE[issue.column].label }}</span>
      <span v-if="issue.tasks.length" class="text-xs text-faint">from its sub-issues</span>
      <span v-else-if="issue.status === 'todo'" class="text-xs text-faint">{{ issue.plan ? `to do, planned ${issue.plan}` : 'to do, unplanned' }}</span>
    </dd>
    <dt class="label">Priority</dt>
    <dd class="flex items-center gap-2"><PriorityIcon :priority="issue.priority" />{{ issue.priority ? `${issue.priority} · ${PRIORITY_LABEL[issue.priority]}` : 'No priority' }}</dd>
    <dt class="label">Assignee</dt>
    <dd class="flex items-center gap-2">
      <template v-if="issue.assignee"><PersonAvatar :name="issue.assignee" />{{ issue.assignee }}</template>
      <span v-else class="text-faint">Unassigned</span>
    </dd>
    <dt class="label">Labels</dt>
    <dd class="flex flex-wrap gap-1">
      <LabelChip v-for="label in issue.labels" :key="label" :label="label" />
      <span v-if="!issue.labels.length" class="text-faint">None</span>
    </dd>
    <dt class="label">Project</dt>
    <dd><NuxtLink :to="`/p/${project.id}`" class="hover:underline">{{ project.name }}</NuxtLink></dd>
    <dt class="label">Chunk</dt>
    <dd class="truncate"><NuxtLink :to="chunkPath(project.id, chunk.id)" class="hover:underline" :class="!chunk.id && 'text-faint'">{{ chunk.title }}</NuxtLink></dd>
    <template v-if="issue.tasks.length">
      <dt class="label">Progress</dt>
      <dd class="flex items-center gap-3"><ProgressRing :counts="issue.counts" /><ColumnBar :counts="issue.counts" class="max-w-32" /></dd>
    </template>
    <dt class="label">Created by</dt>
    <dd class="flex flex-wrap items-center gap-x-2 text-muted">
      {{ issue.createdBy }}
      <span v-if="issue.protected" class="flex items-center gap-1 text-xs text-faint" title="Only the owner can delete it">
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        protected
      </span>
    </dd>
    <dt class="label">Created</dt>
    <dd class="text-muted" :title="issue.createdAt">{{ ago(issue.createdAt) }}</dd>
    <dt class="label">Updated</dt>
    <dd class="text-muted" :title="issue.updatedAt">{{ ago(issue.updatedAt) }}</dd>
  </dl>
</template>
