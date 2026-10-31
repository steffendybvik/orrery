<script setup lang="ts">
// A button's words while it's at work (docs/components.md): the slot normally, the spinner and `label` while `busy`. Both
// keep their place in the same cell, the one not showing hidden, so the button holds its width as they swap. At rest
// `label` only takes up room, drawn by CSS, so the button's text is just its own words.
defineProps<{busy?: boolean, label: string}>()
</script>

<template>
  <span class="inline-grid">
    <span class="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5" :class="{invisible: busy}"><slot /></span>
    <span v-if="busy" class="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5"><UiSpinner />{{ label }}</span>
    <span v-else class="invisible col-start-1 row-start-1 inline-flex items-center gap-1.5 before:w-[0.72em] after:content-[attr(data-label)] before:content-['']" :data-label="label" aria-hidden="true" />
  </span>
</template>
