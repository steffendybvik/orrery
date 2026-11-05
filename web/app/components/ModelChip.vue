<script setup lang="ts">
import type {RunsOn} from '#shared/roadmap'
import {modelLabel} from '#shared/roadmap'

// What a session runs on, the one chip every place draws (ORR-969). The model is the one its hook says it runs on
// (ORR-871), else the one orrery started it on when it chose one (ORR-868): none for Claude Code's default (`best`).
// Its effort beside it (ORR-894): the one its hook last said, else the one it was started at.
// `normal` (the Sessions page, the chat pane) names the model and effort; `condensed` (the sessions panel, the sidebar)
// only the effort, or the model's family when no effort is known. The title has the rest: started on, runs on now.
const props = withDefaults(defineProps<{session: RunsOn, size?: 'normal' | 'condensed'}>(), {size: 'normal'})
/** The model orrery started it on, if it chose one. */
const chosen = computed(() => {
    const model = props.session.started?.model
    return model && model !== 'best' && model !== 'default' ? model : undefined
})
/** The model the label names: the one it runs on, else the one chosen. */
const model = computed(() => {
    const id = props.session.model ?? chosen.value
    return id && modelLabel(id)
})
const startedAt = computed(() => props.session.started?.effort)
const effort = computed(() => props.session.effort ?? startedAt.value)
const label = computed(() => props.size === 'condensed'
    ? effort.value ?? model.value?.split(' ')[0]
    : [model.value, effort.value].filter(Boolean).join(' · '))
const title = computed(() => {
    const started = chosen.value ? `started on ${chosen.value}${startedAt.value ? `, ${startedAt.value} effort` : ''}`
        : startedAt.value ? `started at ${startedAt.value} effort` : ''
    const now = [
        props.session.model && `runs on ${modelLabel(props.session.model)}`,
        props.session.effort && props.session.effort !== startedAt.value && `at ${props.session.effort} effort`,
    ].filter(Boolean).join(', ')
    const text = [started, now].filter(Boolean).join(' · ')
    return text.charAt(0).toUpperCase() + text.slice(1)
})
</script>

<template>
  <span
      v-if="label"
      class="shrink-0 rounded bg-well font-mono text-[10px] leading-4 text-muted ring-1 ring-line"
      :class="size === 'condensed' ? 'px-1' : 'px-1.5'"
      :title="title"
      data-testid="model-chip"
  >{{ label }}</span>
</template>
