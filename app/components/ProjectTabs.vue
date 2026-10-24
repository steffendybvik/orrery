<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// Issues | Docs, next to a project's name.
const props = defineProps<{project: Project}>()
const route = useRoute()
const tabs = computed(() => [
    {to: `/p/${props.project.id}`, label: 'Issues', active: !route.path.includes('/docs')},
    {to: `/p/${props.project.id}/docs`, label: 'Docs', count: props.project.docs.length, active: route.path.includes('/docs')},
])
</script>

<template>
  <nav class="ml-1 flex items-center gap-0.5">
    <NuxtLink
        v-for="tab in tabs"
        :key="tab.label"
        :to="tab.to"
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors"
        :class="tab.active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
    >
      {{ tab.label }}
      <span v-if="tab.count" class="font-mono text-[10px] text-faint">{{ tab.count }}</span>
    </NuxtLink>
  </nav>
</template>
