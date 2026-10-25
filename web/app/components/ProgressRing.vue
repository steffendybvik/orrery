<script setup lang="ts">
import type {Kinds} from '#shared/roadmap'

// Done leaves out of all (canceled ones left out), as a ring and (unless `bare`) "12/20".
const props = withDefaults(defineProps<{kinds: Kinds, bare?: boolean, size?: number}>(), {size: 16})
const share = computed(() => progress(props.kinds))
const circumference = 2 * Math.PI * 6
</script>

<template>
  <span class="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-faint tabular-nums" :title="`${share.done} of ${share.total} done`">
    <svg :width="size" :height="size" viewBox="0 0 16 16" class="-rotate-90">
      <circle cx="8" cy="8" r="6" fill="none" stroke-width="2" class="stroke-line" />
      <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          :stroke-dasharray="`${share.share * circumference} ${circumference}`"
          :class="share.share === 1 ? 'stroke-emerald-500' : 'stroke-accent-500'"
          class="transition-[stroke-dasharray] duration-500"
      />
    </svg>
    <span v-if="!bare">{{ share.done }}/{{ share.total }}</span>
  </span>
</template>
