<script setup lang="ts">
// An issue's id, with its copy buttons: what stays in view on its page (ORR-649).
defineProps<{id: string, reference: string}>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5" data-testid="issue-id">
    <span class="font-mono text-xs whitespace-nowrap text-faint">{{ id }}</span>
    <CopyButton :text="id" compact />
    <CopyButton :text="reference" label="Copy ref" :name="`${reference}, for a commit body or PR description`" compact />
  </div>
</template>
