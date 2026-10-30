<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The owner's Forget (×) for a session nothing can reach: started without the channel, so orrery only knows it from
// its hooks, and a terminal closed by hand sends none. It takes it off the list and nothing else, so it asks nothing
// first: if the session is still running, its next hook brings it back.
const props = defineProps<{session: Session}>()
const busy = ref(false)
const failed = ref('')

async function forget() {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.session.project)}/sessions/${encodeURIComponent(props.session.id)}/forget`, {
            method: 'POST',
        })
    } catch (error) {
        failed.value = errorMessage(error)
    }
    busy.value = false
}
</script>

<template>
  <span class="flex shrink-0 items-center gap-1.5 text-xs">
    <span v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</span>
    <UiButton
        variant="ghost"
        size="xs"
        square
        :disabled="busy"
        :aria-label="`Forget ${session.name}`"
        title="Remove from the list. If it's still running, its next hook brings it back."
        @click="forget"
    >
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </UiButton>
  </span>
</template>
