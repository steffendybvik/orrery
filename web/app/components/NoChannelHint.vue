<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The one quiet line on sessions started without the channel (ORR-716): they aren't listed, or can't hear the owner if
// their channel can still stop them, so this is the one place that says why, with the command that restarts them
// with it. `where` is where they are, as the sentence says it.
const props = defineProps<{sessions: Session[], project: string, where: string}>()
const {environment} = useRuntimeConfig().public
const command = computed(() => {
    const [first] = props.sessions
    return restartCommand({name: props.sessions.length === 1 ? first?.name : undefined, project: props.project, server: first?.server}, String(environment || 'personal'))
})
</script>

<template>
  <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint" :title="command">
    {{ sessions.length === 1 ? '1 Claude session' : `${sessions.length} Claude sessions` }} {{ where }} started without the channel: restart {{ sessions.length === 1 ? 'it' : 'them' }} with
    <CopyButton :text="command" label="Copy command" />
  </p>
</template>
