<script setup lang="ts">
import type {Column} from '#shared/roadmap'
import {COLUMNS, PRIORITIES} from '#shared/roadmap'

// Search (`/`), then the priority and column filters, shared by every view.
const {filters, active, clear} = useFilters()
const priorities = [...PRIORITIES.map(p => ({value: p as string, label: `${p} · ${PRIORITY_LABEL[p]}`})), {value: 'none', label: 'No priority'}]
const columns = COLUMNS.map(c => ({value: c as Column, label: COLUMN_STYLE[c].label}))
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
      >
      <KeyHint v-if="!filters.query" class="hidden group-focus-within:hidden sm:inline-flex">/</KeyHint>
    </label>
    <FilterMenu v-model="filters.priorities" label="Priority" :options="priorities" class="hidden sm:block">
      <template #option="{value}"><PriorityIcon :priority="value === 'none' ? undefined : value" /></template>
    </FilterMenu>
    <FilterMenu v-model="filters.columns" label="Column" :options="columns" class="hidden sm:block">
      <template #option="{value}"><StatusIcon :column="value" /></template>
    </FilterMenu>
    <button v-if="active" type="button" class="h-7 shrink-0 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg" @click="clear">Clear</button>
  </div>
</template>
