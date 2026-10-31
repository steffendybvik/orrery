<script setup lang="ts">
// An assignee's initials on a colour of their own; an agent gets the accent. The owner shows as their name.
const props = withDefaults(defineProps<{name: string, size?: number}>(), {size: 18})
const {who} = useOwner()
const shown = computed(() => who(props.name))
const COLOURS = ['bg-sky-700', 'bg-violet-700', 'bg-emerald-700', 'bg-rose-700', 'bg-teal-700', 'bg-fuchsia-700', 'bg-indigo-700', 'bg-lime-700']
const colour = computed(() => {
    if (props.name.toLowerCase().startsWith('claude')) return 'bg-accent-fill'
    let hash = 0
    for (const char of shown.value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return COLOURS[hash % COLOURS.length]
})
const initials = computed(() => shown.value.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join(''))
</script>

<template>
  <span
      class="inline-grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-canvas"
      :class="colour"
      :style="{width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.45)}px`}"
      :title="shown"
  >{{ initials }}</span>
</template>
