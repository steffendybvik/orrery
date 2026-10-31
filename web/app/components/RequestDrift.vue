<script setup lang="ts">
import type {ChatRequestDrift} from '#shared/roadmap'

// What has changed on what a chat's request would change since it asked (ORR-645).
defineProps<{drifted?: ChatRequestDrift[]}>()
</script>

<template>
  <ul v-if="drifted?.length" class="flex flex-col gap-0.5 text-xs text-amber-800 dark:text-amber-400" data-testid="request-drifted">
    <li>Changed since it asked:</li>
    <li v-for="d in drifted" :key="d.label">{{ d.label }} is now {{ d.to }} (was {{ d.from }})</li>
  </ul>
</template>
