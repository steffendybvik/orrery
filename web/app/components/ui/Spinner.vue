<script lang="ts">
// The braille cycle, as dots on a 2×3 cell: bit n of a glyph's code is braille dot n+1. Drawn rather than typed, as Geist
// Mono has no braille and the fallback font changes by machine, in shape and in width.
const FRAMES = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
const CELL = [[3, 3], [3, 7], [3, 11], [7, 3], [7, 7], [7, 11]] as const
const DOTS = FRAMES.flatMap((glyph, frame) => CELL.flatMap(([x, y], dot) =>
    ((glyph.codePointAt(0) ?? 0) - 0x2800) >> dot & 1 ? [{x, y: y + frame * 14}] : []))
</script>

<script setup lang="ts">
// Anything loading shows this (docs/components.md). It's 1em tall and takes its colour from where it sits, so it fits a
// button or a line of text. The frames sit in one tall picture that CSS moves a frame at a time, so there's no timer, and
// with reduced motion it stays on the first. It says nothing itself: the words beside it say what's loading, or `label`
// when there are none.
defineProps<{label?: string}>()
</script>

<template>
  <span
      class="inline-block h-[1em] w-[0.72em] shrink-0 overflow-hidden align-[-0.125em]"
      data-testid="spinner"
      :role="label ? 'img' : undefined"
      :aria-label="label"
      :aria-hidden="label ? undefined : 'true'"
  >
    <svg class="block h-[1000%] w-full animate-spinner motion-reduce:animate-none" viewBox="0 0 10 140" fill="currentColor">
      <circle v-for="(dot, i) in DOTS" :key="i" :cx="dot.x" :cy="dot.y" r="1.4" />
    </svg>
  </span>
</template>
