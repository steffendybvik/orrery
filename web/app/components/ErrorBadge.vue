<script setup lang="ts">
// A count of what's gone wrong: red, with a warning sign, as an error is never told by its colour alone (docs/components.md).
defineProps<{count: number}>()
</script>

<template>
  <span class="inline-flex shrink-0 items-center justify-center gap-0.5 rounded-full bg-rose-700 px-1 font-mono text-[10px] font-medium text-white tabular-nums">
    <svg class="size-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4M12 17h.01" /></svg>
    {{ count }}
  </span>
</template>
