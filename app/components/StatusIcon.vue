<script setup lang="ts">
import type {Column} from '#shared/roadmap'

// The column as an icon: a dashed ring (backlog), a ring (later, next), a ring with a dot
// (now), a pie filling up with progress (doing), a check (done); and a diamond for a proposal.
const props = withDefaults(defineProps<{column: Column, progress?: number, size?: number}>(), {progress: 0.5, size: 14})

const pie = computed(() => {
    const share = Math.min(Math.max(props.progress, 0.12), 0.88)
    const angle = share * 2 * Math.PI
    const [x, y] = [7 + 3.5 * Math.sin(angle), 7 - 3.5 * Math.cos(angle)]
    return `M7 7 L7 3.5 A3.5 3.5 0 ${angle > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`
})
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 14 14" fill="none" class="shrink-0" :class="COLUMN_STYLE[column].text" :aria-label="COLUMN_STYLE[column].label" role="img">
    <template v-if="column === 'done'">
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="m4.4 7.2 1.8 1.8 3.5-3.7" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </template>
    <path v-else-if="column === 'proposed'" d="M7 1.6 12.4 7 7 12.4 1.6 7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    <circle v-else-if="column === 'backlog'" cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.5 1.8" />
    <template v-else>
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" />
      <path v-if="column === 'doing'" :d="pie" fill="currentColor" />
      <circle v-else-if="column === 'now'" cx="7" cy="7" r="2" fill="currentColor" />
    </template>
  </svg>
</template>
