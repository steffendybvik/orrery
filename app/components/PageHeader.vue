<script setup lang="ts">
// The top bar of a page: the menu button (phones), the title, and the page's controls on the right.
const sidebar = useState('sidebar-open', () => false)
</script>

<template>
  <header class="sticky top-0 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-canvas/85 px-3 py-2 backdrop-blur-xl sm:px-4">
    <button type="button" class="-ml-1 rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg md:hidden" aria-label="Open the sidebar" @click="sidebar = true">
      <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <slot />
    </div>
    <div class="flex w-full min-w-0 items-center gap-2 sm:w-auto">
      <slot name="actions" />
    </div>
  </header>
</template>
