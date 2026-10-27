<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// A preset's badge, so it reads as a role rather than a line of text: its icon (or, without one, its initials) on a
// rounded square in its colour; a square, so a role doesn't pass for a person's avatar. Without a colour, the text's.
const props = withDefaults(defineProps<{preset: {name: string, icon?: string | null, color?: string | null}, size?: number}>(), {size: 20})
const color = computed(() => props.preset.color ? TINTS[props.preset.color as keyof typeof TINTS] ?? props.preset.color : null)
const style = computed(() => ({
    width: `${props.size}px`,
    height: `${props.size}px`,
    fontSize: `${Math.round(props.size * 0.42)}px`,
    ...color.value ? {color: color.value, background: `color-mix(in srgb, ${color.value} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color.value} 35%, transparent)`} : {},
}))
const initials = computed(() => props.preset.name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join(''))
</script>

<template>
  <span
      class="inline-grid shrink-0 place-items-center rounded-[28%] font-semibold"
      :class="color ? '' : 'bg-active text-muted ring-1 ring-inset ring-line'"
      :style="style"
      aria-hidden="true"
  >
    <ProjectIcon v-if="preset.icon" :icon="preset.icon" :style="{width: `${Math.round(size * 0.6)}px`, height: `${Math.round(size * 0.6)}px`}" />
    <template v-else>{{ initials }}</template>
  </span>
</template>
