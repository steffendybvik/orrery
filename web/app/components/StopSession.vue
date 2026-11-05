<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The owner's Stop for a session opened in a terminal: its orrery channel ends it, on the first press (ORR-971).
const props = defineProps<{session: Session}>()
const busy = ref(false)
const failed = ref('')

async function stop() {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.session.project)}/sessions/${encodeURIComponent(props.session.id)}/stop`, {
            method: 'POST',
        })
    } catch (error) {
        failed.value = errorMessage(error)
        busy.value = false
    }
}
</script>

<template>
  <span class="flex shrink-0 items-center gap-1.5 text-xs">
    <UiButton
        variant="danger-outline"
        size="xs"
        :disabled="busy"
        :title="`End ${session.name}: it quits in its terminal`"
        @click="stop"
    >
      <UiBusy :busy="busy" label="Stopping…">Stop</UiBusy>
    </UiButton>
    <span v-if="failed" class="text-rose-700 dark:text-rose-400">{{ failed }}</span>
  </span>
</template>
