<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {modelLabel} from '#shared/roadmap'

// The model orrery started a session on (ORR-868), when it chose one: none for Claude Code's default (`best`), nor for a
// session opened by hand. Its effort level beside it (ORR-894): the one its hook last said, else the one it was started
// at, on the default model too. What it actually runs on, when its hooks have said, is in the title.
const props = defineProps<{session: Pick<Session, 'model' | 'effort' | 'started'>}>()
const picked = computed(() => {
    const model = props.session.started?.model
    return model && model !== 'best' && model !== 'default' ? model : undefined
})
const startedAt = computed(() => props.session.started?.effort)
const effort = computed(() => props.session.effort ?? startedAt.value)
const label = computed(() => [picked.value && (picked.value.startsWith('claude-') ? modelLabel(picked.value) : picked.value), effort.value].filter(Boolean).join(' · '))
const title = computed(() => [
    picked.value ? `Started on ${picked.value}${startedAt.value ? `, ${startedAt.value} effort` : ''}` : startedAt.value ? `Started at ${startedAt.value} effort` : '',
    props.session.effort && props.session.effort !== startedAt.value ? `at ${props.session.effort} effort now` : '',
    props.session.model && props.session.model !== picked.value ? `runs on ${modelLabel(props.session.model)}` : '',
].filter(Boolean).join(' · '))
</script>

<template>
  <span v-if="label" class="shrink-0 rounded bg-well px-1 font-mono text-[10px] leading-4 text-muted ring-1 ring-line" :title="title" data-testid="model-chip">{{ label }}</span>
</template>
