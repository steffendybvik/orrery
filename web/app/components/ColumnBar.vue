<script setup lang="ts">
import type {Counts} from '#shared/roadmap'

// A thin bar split by where the leaves are: done first, then started, todo and backlog, each status in
// its colour. Proposals aren't work yet and canceled ones won't be, so they're not in the bar.
const props = defineProps<{counts: Counts}>()
const {statuses, look} = useStatuses()
const parts = computed(() => {
    const order = (['done', 'started', 'todo', 'backlog'] as const).flatMap(kind => statuses.value.filter(s => s.kind === kind))
    const all = order.reduce((sum, s) => sum + (props.counts[s.id] ?? 0), 0) || 1
    return order.flatMap(s => {
        const n = props.counts[s.id]
        return n ? [{column: s.id, width: `${(n / all) * 100}%`}] : []
    })
})
</script>

<template>
  <div class="flex h-1 w-full gap-px overflow-hidden rounded-full bg-well">
    <div v-for="part in parts" :key="part.column" class="h-full transition-[width] duration-500" :style="{width: part.width, background: look(part.column).color}" :title="`${counts[part.column]} ${look(part.column).label}`" />
  </div>
</template>
