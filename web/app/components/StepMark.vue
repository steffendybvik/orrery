<script setup lang="ts">
// A step's number in a guide, a tick once it's done.
defineProps<{n: number, done: boolean}>()
</script>

<template>
  <span
      class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-medium"
      :class="done ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-well text-faint ring-1 ring-line'"
  >
    <svg v-if="done" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
    <template v-else>{{ n }}</template>
  </span>
</template>
