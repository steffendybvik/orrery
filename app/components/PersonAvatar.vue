<script setup lang="ts">
// An assignee's initials on a colour of their own; Claude gets the accent.
const props = withDefaults(defineProps<{name: string, size?: number}>(), {size: 18})
const COLOURS = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-rose-500', 'bg-teal-500', 'bg-fuchsia-500', 'bg-indigo-500', 'bg-lime-600']
const colour = computed(() => {
    if (props.name.toLowerCase().startsWith('claude')) return 'bg-gradient-to-br from-accent-300 to-accent-600'
    let hash = 0
    for (const char of props.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return COLOURS[hash % COLOURS.length]
})
const initials = computed(() => props.name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join(''))
</script>

<template>
  <span
      class="inline-grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-canvas"
      :class="colour"
      :style="{width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.45)}px`}"
      :title="name"
  >{{ initials }}</span>
</template>
