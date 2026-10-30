<script setup lang="ts">
// An issue's id, with the button that copies its full form: what stays in view on its page (ORR-649).
defineProps<{id: string, full: string}>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5" data-testid="issue-id">
    <span class="font-mono text-xs whitespace-nowrap text-faint">{{ id }}</span>
    <CopyButton :text="full" :name="full" compact />
  </div>
</template>
