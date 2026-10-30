<script setup lang="ts">
import {diffHunks, lineDiff} from '#shared/line-diff'

// What changed between two versions of a doc's text, line by line with the unchanged runs folded, all of it as written.
// Used by a chat's request to change a doc (ChatDocCard) and a doc's history (DocHistory).
const props = defineProps<{from: string, to: string}>()

const lines = computed(() => diffHunks(lineDiff(props.from, props.to)))
const MARK = {same: ' ', added: '+', removed: '−'}
const TINT = {same: 'text-muted', added: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', removed: 'bg-rose-500/10 text-rose-700 dark:text-rose-300'}
</script>

<template>
  <div class="overflow-auto rounded-lg bg-panel p-2 font-mono text-xs ring-1 ring-line" tabindex="0" data-testid="doc-diff">
    <template v-for="(line, at) in lines" :key="at">
      <div v-if="line.kind === 'skipped'" class="py-0.5 text-faint">… {{ line.count }} unchanged {{ line.count === 1 ? 'line' : 'lines' }}</div>
      <div v-else class="flex gap-2 px-1" :class="TINT[line.kind]" :data-diff="line.kind">
        <span class="shrink-0 select-none" aria-hidden="true">{{ MARK[line.kind] }}</span>
        <span class="min-w-0 break-words whitespace-pre-wrap">{{ line.text || ' ' }}</span>
      </div>
    </template>
  </div>
</template>
