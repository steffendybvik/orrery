<script setup lang="ts">
import type {Chunk, Column} from '#shared/roadmap'
import {COLUMNS} from '#shared/roadmap'

// The columns Doing…Done with the chunks in them. Done starts folded to a count.
const props = defineProps<{chunks: Chunk[], project: string}>()
const opened = ref<Set<string>>(new Set())
const showDone = ref(false)

const columns = computed(() => COLUMNS.map(column => ({column, chunks: props.chunks.filter(c => c.column === column)})))

function toggle(id: string) {
    const next = new Set(opened.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    opened.value = next
}
const folded = (column: Column) => column === 'done' && !showDone.value
</script>

<template>
  <div class="flex h-full snap-x scroll-px-3 gap-3 overflow-x-auto p-3 sm:scroll-px-4 sm:p-4">
    <section
        v-for="{column, chunks: inColumn} in columns"
        :key="column"
        class="flex shrink-0 snap-start flex-col"
        :class="folded(column) ? 'w-44' : 'w-[85vw] sm:w-72'"
    >
      <header class="mb-2 flex h-7 items-center gap-2 px-1">
        <StatusIcon :column="column" />
        <h2 class="text-[13px] font-medium">{{ COLUMN_STYLE[column].label }}</h2>
        <span class="font-mono text-[11px] text-faint tabular-nums">{{ inColumn.length }}</span>
        <button v-if="column === 'done' && inColumn.length" type="button" class="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-hover hover:text-fg" @click="showDone = !showDone">
          {{ showDone ? 'Fold' : 'Show' }}
        </button>
      </header>
      <button
          v-if="folded(column)"
          type="button"
          data-nav
          class="flex flex-col items-start gap-1 rounded-xl border border-dashed border-line p-3 text-left text-xs text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent-500/50"
          @click="showDone = true"
      >
        <span class="font-mono text-lg font-medium text-emerald-600 tabular-nums dark:text-emerald-400">{{ inColumn.length }}</span>
        {{ inColumn.length === 1 ? 'chunk' : 'chunks' }} done
      </button>
      <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
        <ChunkCard
            v-for="chunk in inColumn"
            :key="chunk.id || 'none'"
            :chunk="chunk"
            :project="project"
            :open="opened.has(chunk.id)"
            @toggle="toggle(chunk.id)"
        />
        <div v-if="!inColumn.length" class="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-faint">Nothing here</div>
      </div>
    </section>
  </div>
</template>
