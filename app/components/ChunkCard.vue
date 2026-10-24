<script setup lang="ts">
import type {Chunk} from '#shared/roadmap'
import {COLUMNS} from '#shared/roadmap'

// A chunk on the roadmap: its progress and where its issues are. Clicking opens its page.
const props = defineProps<{chunk: Chunk, project: string}>()
const share = computed(() => progress(props.chunk.counts))
const spread = computed(() => COLUMNS.filter(c => c !== 'done' && props.chunk.counts[c]).map(c => ({column: c, n: props.chunk.counts[c]})))
</script>

<template>
  <NuxtLink
      data-nav
      :to="chunkPath(project, chunk.id)"
      class="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-3 shadow-sm shadow-black/5 outline-none transition-colors hover:border-faint/40 focus-visible:ring-2 focus-visible:ring-accent-500/50 dark:shadow-black/30"
  >
    <div class="flex items-start gap-2">
      <StatusIcon :column="chunk.column" :progress="share.share" class="mt-0.5" />
      <PriorityIcon v-if="chunk.priority" :priority="chunk.priority" class="mt-0.5" />
      <h3 class="min-w-0 flex-1 text-[13px] leading-snug font-medium" :class="chunk.id ? 'text-fg' : 'text-muted italic'">{{ chunk.title }}</h3>
      <span class="font-mono text-[11px] text-faint tabular-nums">{{ chunk.tasks.length }}</span>
    </div>
    <p v-if="chunk.summary" class="line-clamp-2 text-xs leading-relaxed text-muted"><InlineText :text="chunk.summary" /></p>
    <ColumnBar :counts="chunk.counts" />
    <div class="flex items-center gap-2 text-[11px] text-faint">
      <ProgressRing :counts="chunk.counts" :size="13" />
      <span class="ml-auto flex items-center gap-2">
        <span v-for="part in spread" :key="part.column" class="flex items-center gap-1" :title="`${part.n} ${COLUMN_STYLE[part.column].label}`">
          <span class="size-1.5 rounded-full" :class="COLUMN_STYLE[part.column].fill" />{{ part.n }}
        </span>
      </span>
    </div>
  </NuxtLink>
</template>
