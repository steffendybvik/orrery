<script setup lang="ts">
import type {ContextUse} from '#shared/roadmap'
import {contextShare} from '#shared/roadmap'

// How much context a session carries (ORR-968), as its hook last said: a thin bar for how full its model's window is,
// and the share beside it. Every turn pays for those tokens again, so a full one is worth a clear between tasks. It
// turns amber from FULL on. `condensed` is the bar alone (the sidebar); the numbers are in the title either way.
const props = defineProps<{context?: ContextUse, condensed?: boolean}>()
const FULL = 0.6
const share = computed(() => props.context ? contextShare(props.context) : 0)
const percent = computed(() => Math.round(share.value * 100))
const thousands = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
const title = computed(() => props.context ? [
    `${thousands(props.context.tokens)} of ${thousands(props.context.window)} tokens in context (${percent.value}%)`,
    props.context.compacted ? 'compacted since its last clear' : '',
].filter(Boolean).join(' · ') : '')
</script>

<template>
  <span v-if="context" class="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4 text-faint" :title="title" data-testid="context-meter">
    <span class="h-1 overflow-hidden rounded-full bg-well ring-1 ring-line" :class="condensed ? 'w-3' : 'w-6'">
      <span class="block h-full rounded-full" :class="share >= FULL ? 'bg-amber-500' : 'bg-fg/40'" :style="{width: `${percent}%`}" />
    </span>
    <span v-if="!condensed" class="font-mono tabular-nums" :class="share >= FULL ? 'text-amber-800 dark:text-amber-400' : ''">{{ percent }}%{{ context.compacted ? ' ↺' : '' }}</span>
  </span>
</template>
