<script setup lang="ts">
import type {Chunk} from '#shared/roadmap'

// Chunks as groups that fold, issues as rows, sub-issues indented. Done chunks start folded,
// unless a filter is on.
const props = defineProps<{chunks: Chunk[], project: string}>()
const {active} = useFilters()
const toggled = ref<Record<string, boolean>>({})
const isOpen = (chunk: Chunk) => toggled.value[chunk.id] ?? (active.value || chunk.column !== 'done')

function toggle(chunk: Chunk) {
    toggled.value = {...toggled.value, [chunk.id]: !isOpen(chunk)}
}
</script>

<template>
  <div class="pb-16">
    <section v-for="chunk in props.chunks" :key="chunk.id || 'none'">
      <div
          data-nav
          tabindex="0"
          role="button"
          :aria-expanded="isOpen(chunk)"
          class="sticky top-0 z-10 flex h-9 cursor-pointer items-center gap-2.5 border-b border-line bg-panel/90 px-3 outline-none backdrop-blur hover:bg-hover focus-visible:bg-active"
          @click="toggle(chunk)"
      >
        <svg class="size-3 shrink-0 text-faint transition-transform" :class="isOpen(chunk) && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        <StatusIcon :column="chunk.column" :progress="progress(chunk.counts).share" />
        <h3 class="min-w-0 truncate text-[13px] font-medium" :class="!chunk.id && 'text-muted italic'">{{ chunk.title }}</h3>
        <ProgressRing :counts="chunk.counts" :size="13" />
        <span v-if="chunk.summary" class="hidden min-w-0 flex-1 truncate text-xs text-faint md:inline"><InlineText :text="chunk.summary" /></span>
        <span class="ml-auto shrink-0 text-xs" :class="COLUMN_STYLE[chunk.column].text">{{ COLUMN_STYLE[chunk.column].label }}</span>
      </div>
      <div v-if="isOpen(chunk)">
        <IssueRow v-for="issue in chunk.tasks" :key="issue.id" :issue="issue" :project="project" />
        <p v-if="!chunk.tasks.length" class="border-b border-line/60 px-10 py-2 text-xs text-faint">No issues yet</p>
      </div>
    </section>
  </div>
</template>
