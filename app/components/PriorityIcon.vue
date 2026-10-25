<script setup lang="ts">
// An orange square with "!" for P0 (urgent), then bars: three for P1 (high), two for P2,
// one for P3; three dots when there's none.
const props = withDefaults(defineProps<{priority?: string, size?: number}>(), {priority: undefined, size: 14})
const bars = computed(() => ({P1: 3, P2: 2, P3: 1})[props.priority ?? ''] ?? 0)
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 14 14" class="shrink-0" role="img" :aria-label="PRIORITY_LABEL[priority ?? 'none']">
    <title>{{ PRIORITY_LABEL[priority ?? 'none'] }}</title>
    <template v-if="priority === 'P0'">
      <rect x="1" y="1" width="12" height="12" rx="3" class="fill-accent-500" />
      <path d="M7 4v3.6" stroke="white" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="7" cy="10" r="1" fill="white" />
    </template>
    <template v-else-if="bars">
      <rect
          v-for="i in 3"
          :key="i"
          :x="1.5 + (i - 1) * 4"
          :y="10.5 - i * 3"
          width="2.5"
          :height="i * 3 + 1"
          rx="0.75"
          :class="i <= bars ? 'fill-muted' : 'fill-line'"
      />
    </template>
    <g v-else class="fill-faint/60">
      <circle cx="3" cy="7" r="1" /><circle cx="7" cy="7" r="1" /><circle cx="11" cy="7" r="1" />
    </g>
  </svg>
</template>
