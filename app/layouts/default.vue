<script setup lang="ts">
useHotkeys()
</script>

<template>
  <div class="flex h-dvh overflow-hidden">
    <AppSidebar />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <slot />
    </main>
    <CommandPalette />
  </div>
</template>
