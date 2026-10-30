<script setup lang="ts">
import type {DocSummary, Project} from '#shared/roadmap'

// One doc in DocsNav: its link, marked when it's open or changed since it was last read, and draggable onto a section.
defineProps<{project: Project, doc: DocSummary, here: boolean, unseen: boolean}>()
</script>

<template>
  <NuxtLink
      data-nav
      draggable="true"
      :to="`/p/${project.id}/docs/${doc.id}`"
      class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none transition-colors focus-visible:bg-active md:shrink"
      :class="[here ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg', unseen && 'unseen-row']"
      title="Drag onto a section, or right-click to move it"
  >
    <svg v-if="doc.kind === 'artifact'" class="size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>Artifact</title><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></svg>
    <svg v-else class="size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /></svg>
    <span class="truncate" :class="unseen ? 'font-semibold text-fg' : ''">{{ doc.title }}</span>
    <span v-if="unseen" class="unseen-dot" title="Changed since you last opened it" />
  </NuxtLink>
</template>
