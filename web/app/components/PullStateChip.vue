<script setup lang="ts">
import type {PastPull, PullState} from '#shared/roadmap'

// Where an open pull request stands, as a chip: what it waits on before it can merge (ORR-485), red when it needs
// someone, amber while it waits, green when ready. On an issue's page and the Pull requests page. On an issue's page
// also how one it keeps from before ended (ORR-795).
defineProps<{state: PullState | PastPull['state']}>()

const STATES: Record<PullState | PastPull['state'], {label: string, hint: string, tone: string}> = {
    conflicting: {label: 'Conflicts', hint: 'It conflicts with its base: it needs the conflicts resolved before it can merge', tone: 'text-rose-700 ring-rose-500/40 bg-rose-500/10 dark:text-rose-300'},
    failing: {label: 'Checks failing', hint: 'Some of its checks fail', tone: 'text-rose-700 ring-rose-500/40 bg-rose-500/10 dark:text-rose-300'},
    behind: {label: 'Behind', hint: 'Its base has moved on: it needs updating before it can merge', tone: 'text-amber-800 ring-amber-500/40 bg-amber-500/10 dark:text-amber-300'},
    blocked: {label: 'Waiting', hint: 'It waits on a review or a required check before it can merge', tone: 'text-amber-800 ring-amber-500/40 bg-amber-500/10 dark:text-amber-300'},
    draft: {label: 'Draft', hint: 'Still a draft', tone: 'text-muted ring-line'},
    ready: {label: 'Ready to merge', hint: 'Nothing stands in its way', tone: 'text-emerald-700 ring-emerald-500/40 bg-emerald-500/10 dark:text-emerald-300'},
    merged: {label: 'Merged', hint: 'It merged', tone: 'text-accent-700 ring-accent-500/30 bg-accent-500/10 dark:text-accent-300'},
    closed: {label: 'Closed', hint: 'It closed without merging', tone: 'text-muted ring-line'},
    open: {label: 'Open when last seen', hint: "The project has since left this repo, so orrery no longer reads it", tone: 'text-faint ring-line'},
    checking: {label: 'Checking', hint: 'GitHub is still working out whether it can merge', tone: 'text-faint ring-line'},
}
</script>

<template>
  <span class="flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ring-1" :class="STATES[state].tone" :title="STATES[state].hint">{{ STATES[state].label }}</span>
</template>
