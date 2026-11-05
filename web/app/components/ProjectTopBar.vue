<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// A project tab's top bar (ORR-857), the same on each: the project / the tab, then its key and progress (from a phone's
// width up), so a phone, with the sidebar shut, still says which tab it's on. The project's name is the page's h1,
// unless `titled`, where the page has an h1 of its own (a doc's title). Given `to`, the tab is a link back to it, and
// the default slot carries the crumbs after it (a doc's title).
const props = defineProps<{project: Project, tab: string, to?: string, titled?: boolean}>()
const named = computed(() => props.titled ? 'span' : 'h1')
</script>

<template>
  <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
    <component :is="named" class="shrink-0 truncate text-sm font-medium">
      <NuxtLink :to="`/p/${project.id}`" class="hover:underline">{{ project.name }}</NuxtLink>
    </component>
    <span class="text-faint" aria-hidden="true">/</span>
    <NuxtLink v-if="to" :to="to" class="shrink-0 text-muted hover:text-fg">{{ tab }}</NuxtLink>
    <span v-else class="shrink-0 text-muted" aria-current="page">{{ tab }}</span>
    <slot />
  </nav>
  <span class="rounded bg-well px-1.5 py-px font-mono text-[10px] text-faint ring-1 ring-line max-sm:hidden">{{ project.key }}</span>
  <ProgressRing :kinds="project.board.kinds" class="max-sm:hidden" />
</template>
