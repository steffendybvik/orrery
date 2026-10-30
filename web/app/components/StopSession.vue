<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The owner's Stop for a session opened in a terminal: its orrery channel ends it. It asks once more first,
// as whatever the session was in the middle of goes with it.
const props = defineProps<{session: Session}>()
const sure = ref(false)
const busy = ref(false)
const failed = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(timer))

async function stop() {
    if (!sure.value) {
        sure.value = true
        clearTimeout(timer)
        timer = setTimeout(() => sure.value = false, 3000)
        return
    }
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
    sure.value = false
}
</script>

<template>
  <span class="flex shrink-0 items-center gap-1.5 text-xs">
    <UiButton
        variant="danger-outline"
        size="xs"
        :class="{'bg-rose-500/10': sure}"
        :disabled="busy"
        :title="`End ${session.name}: it quits in its terminal`"
        @click="stop"
    >
      {{ busy ? 'Stopping…' : sure ? 'Stop it?' : 'Stop' }}
    </UiButton>
    <span v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</span>
  </span>
</template>
