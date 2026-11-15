<script setup lang="ts">
import type {RunsOn} from '#shared/roadmap'
import {cardFor} from '#channel/agent-cards.mjs'

// What a session runs on, the one chip every place draws (ORR-969). What it says is the agent's card's (ORR-1074,
// channel/claude-card.mjs): for Claude Code, the model and effort, or in `condensed` (the sessions panel, the sidebar)
// only the effort. `normal` is the Sessions page and the chat pane. The title has the rest.
const props = withDefaults(defineProps<{session: RunsOn, size?: 'normal' | 'condensed'}>(), {size: 'normal'})
const chip = computed(() => cardFor().chip(props.session, props.size))
</script>

<template>
  <span
      v-if="chip.label"
      class="shrink-0 rounded bg-well font-mono text-[10px] leading-4 text-muted ring-1 ring-line"
      :class="size === 'condensed' ? 'px-1' : 'px-1.5'"
      :title="chip.title"
      data-testid="model-chip"
  >{{ chip.label }}</span>
</template>
