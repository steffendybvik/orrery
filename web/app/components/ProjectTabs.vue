<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// Issues | Roadmap | Docs | Schedules | Sessions | Settings, next to a project's name: on phones only. From `md` up the
// sidebar is always there, with the same pages under each project.
const props = defineProps<{project: Project}>()
const route = useRoute()
const {of: schedulesOf} = useSchedules()
const {sessions} = useRoadmaps()
const sections = computed(() => sectionsOf(props.project, route.path, schedulesOf(props.project.id).length, sessions.value[props.project.id]?.length ?? 0))
</script>

<template>
  <nav class="ml-1 flex items-center gap-0.5 md:hidden">
    <NuxtLink
        v-for="section in sections"
        :key="section.id"
        :to="section.to"
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors"
        :class="section.active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
    >
      <SectionIcon :section="section.id" class="hidden sm:block" />
      {{ section.label }}
    </NuxtLink>
  </nav>
</template>
