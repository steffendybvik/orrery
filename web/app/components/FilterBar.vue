<script setup lang="ts">
import {LockClosedIcon} from '@heroicons/vue/16/solid'
import type {Column} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// Search (`/`; Esc clears it, as the browser does a search field, which only says so with `search`),
// then the priority, column, assignee, label, blocked (or ready) and risk filters (Risk once an issue is rated, ORR-879), shared by every view, and off a project's pages the
// project. The assignees and labels to pick from are the ones on this project's issues (every project's off a
// project's pages).
const {filters, changed, usualColumns, clear} = useFilters()
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
const rated = computed(() => filters.value.risks.length > 0 || issues.value.some(i => i.risk))
const risks = [
    {value: 'high' as const, label: 'High risk'}, {value: 'medium' as const, label: 'Medium risk'}, {value: 'low' as const, label: 'Low risk'},
    {value: 'none' as const, label: 'Not rated'},
]
const RISK_DOT: Record<string, string> = {high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-faint'}
const blocked = [{value: 'blocked' as const, label: 'Blocked'}, {value: 'ready' as const, label: 'Ready'}]
const {columns: order} = useStatuses()
const columns = computed(() => order.value.map(c => ({value: c.id as Column, label: c.label})))

// At phone width the menus fold into a Filters button, with the number of filters narrowing what shows, which
// opens them as a list below it (ORR-1281). From `sm` up they sit in the bar as before (`sm:contents`).
const narrowing = computed(() => {
    const {priorities, columns, assignees, labels, blocked, risks, projects} = filters.value
    const usual = usualColumns.value
    const statusSet = columns.length !== usual.length || columns.some(c => !usual.includes(c))
    return [priorities, assignees, labels, blocked, risks].filter(f => f.length).length + (statusSet ? 1 : 0) + (!here.value && projects.length ? 1 : 0)
})
const root = ref<HTMLElement | null>(null)
const sheet = ref(false)
function outside(event: PointerEvent) {
    if (!root.value?.contains(event.target as Node)) sheet.value = false
}
function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.defaultPrevented) sheet.value = false
}
watch(sheet, open => {
    if (open) {
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', escape)
    } else {
        document.removeEventListener('pointerdown', outside)
        document.removeEventListener('keydown', escape)
    }
})
onBeforeUnmount(() => sheet.value = false)
</script>

<template>
  <div ref="root" class="relative flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none">
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
    <button
        type="button"
        class="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium ring-1 transition-colors sm:hidden"
        :class="narrowing ? 'bg-accent-500/10 text-accent-700 ring-accent-500/30 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
        :aria-expanded="sheet"
        aria-controls="filter-menus"
        @click="sheet = !sheet"
    >
      Filters<span v-if="narrowing" class="tabular-nums"> · {{ narrowing }}</span>
    </button>
    <div
        id="filter-menus"
        class="sm:contents"
        :class="sheet ? 'glass absolute top-full right-0 z-40 mt-1.5 flex w-64 animate-fade-up flex-col gap-1 rounded-xl p-1.5' : 'hidden'"
    >
    <FilterMenu v-if="!here && projectOptions.length > 1" v-model="filters.projects" label="Project" :options="projectOptions">
      <template #option="{value}"><ProjectIcon v-if="icons.has(value)" :icon="icons.get(value)?.icon ?? ''" :color="icons.get(value)?.color" class="size-3.5" /></template>
    </FilterMenu>
    <FilterMenu v-model="filters.priorities" label="Priority" :options="priorities">
      <template #option="{value}"><PriorityIcon :priority="value === 'none' ? undefined : value" /></template>
    </FilterMenu>
    <FilterMenu v-model="filters.columns" label="Status" :options="columns" :usual="{values: usualColumns, label: 'Open'}">
      <template #option="{value}"><StatusIcon :column="value" /></template>
    </FilterMenu>
    <FilterMenu v-model="filters.assignees" label="Assignee" :options="assignees">
      <template #option="{value}"><PersonAvatar v-if="value !== 'none'" :name="value" :size="14" /><span v-else class="size-3.5 rounded-full border border-dashed border-faint" /></template>
    </FilterMenu>
    <FilterMenu v-if="labels.length" v-model="filters.labels" label="Label" :options="labels" />
    <FilterMenu v-model="filters.blocked" label="Blocked" :options="blocked">
      <template #option="{value}"><LockClosedIcon v-if="value === 'blocked'" class="size-3.5 text-amber-600 dark:text-amber-400" /><span v-else class="size-3.5" /></template>
    </FilterMenu>
    <FilterMenu v-if="rated" v-model="filters.risks" label="Risk" :options="risks">
      <template #option="{value}"><span v-if="RISK_DOT[value]" class="size-2 rounded-sm" :class="RISK_DOT[value]" /><span v-else class="size-2 rounded-sm ring-1 ring-faint" /></template>
    </FilterMenu>
    </div>
    <UiButton v-if="changed || (!here && filters.projects.length)" variant="ghost" class="shrink-0" title="Back to the open issues" @click="clear">Clear</UiButton>
  </div>
</template>
