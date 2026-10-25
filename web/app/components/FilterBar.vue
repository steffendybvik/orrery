<script setup lang="ts">
import type {Column} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// Search (`/`; Esc clears it, as the browser does a search field, which only says so with `search`),
// then the priority, column, assignee and label filters, shared by every view. The assignees and labels
// to pick from are the ones on this project's issues (every project's off a project's pages).
const {filters, changed, clear} = useFilters()
const {projects, byId} = useRoadmaps()
const {who} = useOwner()
const route = useRoute()
const issues = computed(() => {
    const here = byId(route.params.project as string | undefined)
    return (here ? [here] : projects.value).flatMap(p => allIssues(p).map(({issue}) => issue))
})
const sorted = (names: Iterable<string>) => [...new Set(names)].sort((a, b) => a.localeCompare(b))
const assignees = computed(() => [
    ...sorted(issues.value.flatMap(i => i.assignee ? [i.assignee] : [])).map(name => ({value: name, label: who(name)})),
    {value: 'none', label: 'No assignee'},
])
const labels = computed(() => sorted(issues.value.flatMap(i => i.labels)).map(label => ({value: label, label})))
const priorities = [...PRIORITIES.map(p => ({value: p as string, label: `${p} · ${PRIORITY_LABEL[p]}`})), {value: 'none', label: 'No priority'}]
const {columns: order} = useStatuses()
const columns = computed(() => order.value.map(c => ({value: c.id as Column, label: c.label})))
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5">
    <label class="group flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2 ring-1 ring-line focus-within:ring-accent-500/50 sm:w-56 sm:flex-none">
      <svg class="size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
          id="search"
          v-model="filters.query"
          type="search"
          placeholder="Filter by id or title"
          aria-label="Filter by id or title"
          class="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-faint focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @search="filters.query = ($event.target as HTMLInputElement).value"
      >
      <KeyHint v-if="!filters.query" class="hidden group-focus-within:hidden sm:inline-flex">/</KeyHint>
    </label>
    <FilterMenu v-model="filters.priorities" label="Priority" :options="priorities" class="hidden sm:block">
      <template #option="{value}"><PriorityIcon :priority="value === 'none' ? undefined : value" /></template>
    </FilterMenu>
    <FilterMenu v-model="filters.columns" label="Column" :options="columns" class="hidden sm:block">
      <template #option="{value}"><StatusIcon :column="value" /></template>
    </FilterMenu>
    <FilterMenu v-model="filters.assignees" label="Assignee" :options="assignees" class="hidden sm:block">
      <template #option="{value}"><PersonAvatar v-if="value !== 'none'" :name="value" :size="14" /><span v-else class="size-3.5 rounded-full border border-dashed border-faint" /></template>
    </FilterMenu>
    <FilterMenu v-if="labels.length" v-model="filters.labels" label="Label" :options="labels" class="hidden sm:block" />
    <button v-if="changed" type="button" title="Back to the open issues" class="h-7 shrink-0 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg" @click="clear">Clear</button>
  </div>
</template>
