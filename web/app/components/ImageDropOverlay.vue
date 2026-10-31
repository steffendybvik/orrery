<script setup lang="ts">
// What an area taking images (useImageDrop) shows while one is dragged over it: all of it, dashed, saying so. It sits
// over the area (which is positioned) and lets the drag through to it.
</script>

<template>
  <div class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] border-2 border-dashed border-accent-fill bg-accent-500/10 backdrop-blur-[1px]">
    <span class="rounded-full bg-panel px-3 py-1.5 text-[13px] font-medium text-accent-700 shadow-sm ring-1 ring-accent-500/30 dark:text-accent-400">Drop image to add</span>
  </div>
</template>
