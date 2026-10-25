<script setup lang="ts">
// A label as a dot and its name, the dot's colour following from the name.
const props = defineProps<{label: string}>()
const DOTS = ['bg-sky-400', 'bg-violet-400', 'bg-emerald-400', 'bg-amber-400', 'bg-rose-400', 'bg-teal-400', 'bg-fuchsia-400', 'bg-lime-400']
const dot = computed(() => {
    let hash = 0
    for (const char of props.label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return DOTS[hash % DOTS.length]
})
</script>

<template>
  <span class="inline-flex h-5 max-w-36 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] text-muted ring-1 ring-line">
    <span class="size-1.5 shrink-0 rounded-full" :class="dot" />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
