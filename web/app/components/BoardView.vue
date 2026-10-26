<script setup lang="ts">
import type {Chunk, Column} from '#shared/roadmap'

// The columns, started first and closed last, with the chunks in them. Closed ones start folded to a count.
const props = defineProps<{chunks: Chunk[], project: string}>()
const {columns: order, look} = useStatuses()
const unfolded = ref<Column[]>([])

const columns = computed(() => order.value.map(({id}) => ({column: id, chunks: props.chunks.filter(c => c.column === id)})))

const folded = (column: Column) => isClosed(look(column).kind) && !unfolded.value.includes(column)
const fold = (column: Column) => unfolded.value = unfolded.value.includes(column) ? unfolded.value.filter(c => c !== column) : [...unfolded.value, column]
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
        <h2 class="text-[13px] font-medium">{{ look(column).label }}</h2>
        <span class="font-mono text-[11px] text-faint tabular-nums">{{ inColumn.length }}</span>
        <UiButton v-if="isClosed(look(column).kind) && inColumn.length" variant="ghost" size="xs" class="ml-auto" @click="fold(column)">
          {{ folded(column) ? 'Show' : 'Fold' }}
        </UiButton>
      </header>
      <button
          v-if="folded(column)"
          type="button"
          data-nav
          class="flex flex-col items-start gap-1 rounded-xl border border-dashed border-line p-3 text-left text-xs text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent-500/50"
          @click="fold(column)"
      >
        <span class="font-mono text-lg font-medium tabular-nums" :style="{color: look(column).color}">{{ inColumn.length }}</span>
        {{ inColumn.length === 1 ? 'chunk' : 'chunks' }} {{ look(column).label.toLowerCase() }}
      </button>
      <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
        <ChunkCard
            v-for="chunk in inColumn"
            :key="chunk.id || 'none'"
            :chunk="chunk"
            :project="project"
        />
        <div v-if="!inColumn.length" class="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-faint">Nothing here</div>
      </div>
    </section>
  </div>
</template>
