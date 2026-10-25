<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The owner's Stop for a session opened in a terminal: its Orrery channel ends it. It asks once more first,
// as whatever the session was in the middle of goes with it.
const props = defineProps<{session: Session}>()
const {load} = useOwner()
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
        await $fetch(`/api/projects/${encodeURIComponent(props.session.project)}/sessions/${encodeURIComponent(props.session.id)}/stop`, {
            method: 'POST', headers: {'Orrery-Actor': await load()},
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
    <button
        type="button"
        class="h-6 rounded-md px-1.5 text-[11px] text-rose-600 ring-1 ring-rose-500/40 hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-400"
        :class="{'bg-rose-500/10': sure}"
        :disabled="busy"
        :title="`End ${session.name}: Claude quits in its terminal`"
        @click="stop"
    >
      {{ busy ? 'Stopping…' : sure ? 'Stop it?' : 'Stop' }}
    </button>
    <span v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</span>
  </span>
</template>
