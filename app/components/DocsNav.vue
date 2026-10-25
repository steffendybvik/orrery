<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// A project's docs down the side of the docs pages (a row of tabs on a phone).
defineProps<{project: Project}>()
const route = useRoute()
</script>

<template>
  <nav class="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 md:w-60 md:flex-col md:gap-0.5 md:overflow-y-auto md:border-r md:border-b-0 md:px-2 md:py-4" aria-label="Docs">
    <p class="label mb-1 hidden px-2 md:block">Docs</p>
    <NuxtLink
        v-for="doc in project.docs"
        :key="doc.id"
        data-nav
        :to="`/p/${project.id}/docs/${doc.id}`"
        class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none transition-colors focus-visible:bg-active md:shrink"
        :class="route.params.doc === doc.id ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
    >
      <svg class="size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /></svg>
      <span class="truncate">{{ doc.title }}</span>
    </NuxtLink>
  </nav>
</template>
