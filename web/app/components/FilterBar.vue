<script setup lang="ts">
import {LockClosedIcon} from '@heroicons/vue/16/solid'
import type {Column} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// Search (`/`; Esc clears it, as the browser does a search field, which only says so with `search`),
// then the priority, column, assignee, label and blocked (or ready) filters, shared by every view, and off a project's pages the
// project. The assignees and labels to pick from are the ones on this project's issues (every project's off a
// project's pages).
const {filters, changed, clear} = useFilters()
const {projects, byId} = useRoadmaps()
const {ordered} = useProjectOrder()
const {who} = useOwner()
const route = useRoute()
const here = computed(() => byId(route.params.project as string | undefined))
const issues = computed(() => (here.value ? [here.value] : projects.value).flatMap(p => allIssues(p).map(({issue}) => issue)))
const projectOptions = computed(() => ordered.value.map(p => ({value: p.id, label: p.name})))
/** Each project's icon in the Project filter, as in the sidebar. */
const icons = computed(() => new Map(ordered.value.flatMap(p => p.icon && heroicon(p.icon) ? [[p.id, {icon: p.icon, color: p.icon_color}] as const] : [])))
const sorted = (names: Iterable<string>) => [...new Set(names)].sort((a, b) => a.localeCompare(b))
const assignees = computed(() => [
    ...sorted(issues.value.flatMap(i => i.assignee ? [i.assignee] : [])).map(name => ({value: name, label: who(name)})),
    {value: 'none', label: 'No assignee'},
])
const labels = computed(() => sorted(issues.value.flatMap(i => i.labels)).map(label => ({value: label, label})))
const priorities = [...PRIORITIES.map(p => ({value: p as string, label: `${p} · ${PRIORITY_LABEL[p]}`})), {value: 'none', label: 'No priority'}]
const blocked = [{value: 'blocked' as const, label: 'Blocked'}, {value: 'ready' as const, label: 'Ready'}]
const {columns: order} = useStatuses()
const columns = computed(() => order.value.map(c => ({value: c.id as Column, label: c.label})))
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none">
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
    <FilterMenu v-if="!here && projectOptions.length > 1" v-model="filters.projects" label="Project" :options="projectOptions" class="hidden sm:block">
      <template #option="{value}"><ProjectIcon v-if="icons.has(value)" :icon="icons.get(value)?.icon ?? ''" :color="icons.get(value)?.color" class="size-3.5" /></template>
    </FilterMenu>
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
    <FilterMenu v-model="filters.blocked" label="Blocked" :options="blocked" class="hidden sm:block">
      <template #option="{value}"><LockClosedIcon v-if="value === 'blocked'" class="size-3.5 text-amber-600 dark:text-amber-400" /><span v-else class="size-3.5" /></template>
    </FilterMenu>
    <UiButton v-if="changed || (!here && filters.projects.length)" variant="ghost" class="shrink-0" title="Back to the open issues" @click="clear">Clear</UiButton>
  </div>
</template>
