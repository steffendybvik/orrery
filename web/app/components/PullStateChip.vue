<script setup lang="ts">
import type {PullState} from '#shared/roadmap'

// Where an open pull request stands, as a chip: what it waits on before it can merge (ORR-485), red when it needs
// someone, amber while it waits, green when ready. IssuePulls keeps its own copy of these until #370 (ORR-492), which
// changes it, has landed, then takes this instead.
defineProps<{state: PullState}>()

const STATES: Record<PullState, {label: string, hint: string, tone: string}> = {
    conflicting: {label: 'Conflicts', hint: 'It conflicts with its base: it needs the conflicts resolved before it can merge', tone: 'text-rose-700 ring-rose-500/40 bg-rose-500/10 dark:text-rose-300'},
    failing: {label: 'Checks failing', hint: 'Some of its checks fail', tone: 'text-rose-700 ring-rose-500/40 bg-rose-500/10 dark:text-rose-300'},
    behind: {label: 'Behind', hint: 'Its base has moved on: it needs updating before it can merge', tone: 'text-amber-700 ring-amber-500/40 bg-amber-500/10 dark:text-amber-300'},
    blocked: {label: 'Waiting', hint: 'It waits on a review or a required check before it can merge', tone: 'text-amber-700 ring-amber-500/40 bg-amber-500/10 dark:text-amber-300'},
    draft: {label: 'Draft', hint: 'Still a draft', tone: 'text-muted ring-line'},
    ready: {label: 'Ready to merge', hint: 'Nothing stands in its way', tone: 'text-emerald-700 ring-emerald-500/40 bg-emerald-500/10 dark:text-emerald-300'},
    checking: {label: 'Checking', hint: 'GitHub is still working out whether it can merge', tone: 'text-faint ring-line'},
}
</script>

<template>
  <span class="flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ring-1" :class="STATES[state].tone" :title="STATES[state].hint">{{ STATES[state].label }}</span>
</template>
