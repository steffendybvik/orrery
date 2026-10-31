<script setup lang="ts">
// A status change in words: the icon and name of where it started, then where it ended.
defineProps<{before?: string, after?: string}>()
const {look} = useStatuses()
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
    <template v-if="before">
      <StatusIcon :column="before" :size="13" />
      <span>{{ look(before).label }}</span>
      <span class="mx-0.5 text-faint" aria-label="to">→</span>
    </template>
    <template v-if="after">
      <StatusIcon :column="after" :size="13" />
      <span class="font-medium text-fg">{{ look(after).label }}</span>
    </template>
  </span>
</template>
