<script setup lang="ts">
import type {Release} from '#shared/roadmap'
import {isFrozen} from '#shared/roadmap'

// Where a release stands: shipped, frozen or being prepared, with the day.
defineProps<{release: Pick<Release, 'frozen_on' | 'shipped_on'>}>()
</script>

<template>
  <span
      class="rounded-full px-2 py-px text-[11px] font-medium ring-1"
      :class="release.shipped_on ? 'text-emerald-700 ring-emerald-500/30 dark:text-emerald-300' : isFrozen(release) ? 'text-amber-700 ring-amber-500/30 dark:text-amber-300' : 'text-accent-600 ring-accent-500/30 dark:text-accent-300'"
      :title="isFrozen(release) ? 'Feature freeze: fixes, tests and docs; a new feature goes on the next release' : undefined"
  >{{ release.shipped_on ? `Shipped ${release.shipped_on}` : isFrozen(release) ? `Frozen ${release.frozen_on}` : 'Preparing' }}</span>
</template>
