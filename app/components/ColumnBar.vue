<script setup lang="ts">
import type {Counts} from '#shared/roadmap'
import {COLUMNS, total} from '#shared/roadmap'

// A thin bar split by where the leaves are: done first, then doing, now, next, later, backlog.
const props = defineProps<{counts: Counts}>()
// Proposals aren't work yet, so they're not in the bar.
const ORDER = ['done', ...COLUMNS.filter(c => c !== 'done' && c !== 'proposed')] as const
const parts = computed(() => {
    const all = total(props.counts) || 1
    return ORDER.filter(c => props.counts[c]).map(c => ({column: c, width: `${(props.counts[c] / all) * 100}%`}))
})
</script>

<template>
  <div class="flex h-1 w-full gap-px overflow-hidden rounded-full bg-well">
    <div v-for="part in parts" :key="part.column" class="h-full transition-[width] duration-500" :class="COLUMN_STYLE[part.column].fill" :style="{width: part.width}" :title="`${counts[part.column]} ${COLUMN_STYLE[part.column].label}`" />
  </div>
</template>
