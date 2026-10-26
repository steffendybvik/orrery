<script setup lang="ts">
// Getting started, as a page of its own: ⌘K brings it back, and showing it again shows its card on Now.
useHead({title: 'Getting started · Orrery'})
</script>

<template>
  <PageHeader>
    <h1 class="truncate text-sm font-medium">Getting started</h1>
  </PageHeader>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <GettingStarted />
  </div>
</template>
