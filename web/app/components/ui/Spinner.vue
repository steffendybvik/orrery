<script lang="ts">
import {SPINNER_DOT_RADIUS, SPINNER_DOTS, SPINNER_VIEWBOX} from '#shared/spinner'

// The frames are shared with the start-up screen (scripts/spa-loading.ts), which draws the same spinner before Vue exists:
// a change to its speed, size or colour here goes there too.
const DOTS = SPINNER_DOTS
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
    <svg class="block h-[1000%] w-full animate-spinner motion-reduce:animate-none" :viewBox="SPINNER_VIEWBOX" fill="currentColor">
      <circle v-for="(dot, i) in DOTS" :key="i" :cx="dot.x" :cy="dot.y" :r="SPINNER_DOT_RADIUS" />
    </svg>
  </span>
</template>
