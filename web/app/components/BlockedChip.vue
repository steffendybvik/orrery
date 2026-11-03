<script setup lang="ts">
import {LockClosedIcon} from '@heroicons/vue/16/solid'

// Says an issue waits on others not closed yet (ORR-601), on its row and card: nothing hands it out until they are.
// The ones it waits on are in its hover.
const props = defineProps<{blockers: string[]}>()
const title = computed(() => `Waiting on ${props.blockers.join(', ')}`)
</script>

<template>
  <span class="inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] text-amber-800 ring-1 ring-amber-500/40 dark:text-amber-300" :title="title">
    <LockClosedIcon class="size-3" aria-hidden="true" />
    Blocked
  </span>
</template>
