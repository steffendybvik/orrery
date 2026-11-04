<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {modelLabel} from '#shared/roadmap'

// The model orrery started a session on (ORR-868), when it chose one: none for Claude Code's default (`best`), nor for a
// session opened by hand. What it actually runs on, when its hooks have said, is in the title.
const props = defineProps<{session: Pick<Session, 'model' | 'started'>}>()
const picked = computed(() => {
    const model = props.session.started?.model
    return model && model !== 'best' && model !== 'default' ? model : undefined
})
const label = computed(() => picked.value && (picked.value.startsWith('claude-') ? modelLabel(picked.value) : picked.value))
const title = computed(() => [
    `Started on ${picked.value}${props.session.started?.effort ? `, ${props.session.started.effort} effort` : ''}`,
    props.session.model && props.session.model !== picked.value ? `runs on ${modelLabel(props.session.model)}` : '',
].filter(Boolean).join(' · '))
</script>

<template>
  <span v-if="picked" class="shrink-0 rounded bg-well px-1 font-mono text-[10px] leading-4 text-muted ring-1 ring-line" :title="title" data-testid="model-chip">{{ label }}</span>
</template>
