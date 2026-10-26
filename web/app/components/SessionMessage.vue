<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The owner's own words to one listening session, through its channel on `project`: it reads them as a message
// to it alone, nothing typed into its terminal. Enter sends, Shift-Enter starts a new line.
const props = defineProps<{session: Session, project: string}>()
const {load} = useOwner()
const text = ref('')
const busy = ref(false)
const sent = ref(false)
const failed = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(timer))

async function send() {
    const message = text.value.trim()
    if (!message || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.project)}/sessions/${encodeURIComponent(props.session.id)}/message`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {text: message},
        })
        text.value = ''
        sent.value = true
        clearTimeout(timer)
        timer = setTimeout(() => sent.value = false, 2000)
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <form class="flex flex-col gap-1" @submit.prevent="send">
    <div class="flex items-end gap-2">
      <textarea
          v-model="text"
          rows="1"
          :aria-label="`Message ${session.name}`"
          :placeholder="`Message ${session.name}… (only it hears this)`"
          class="field-sizing-content max-h-40 min-h-8 flex-1 resize-none rounded-lg bg-well px-3 py-1.5 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
          @keydown.enter.exact.prevent="send"
      />
      <button
          type="submit"
          class="h-8 shrink-0 rounded-lg px-3 text-xs font-medium text-accent-600 ring-1 ring-accent-500/40 hover:bg-accent-500/10 disabled:opacity-40 dark:text-accent-400"
          :disabled="!text.trim() || busy"
      >
        {{ busy ? 'Sending…' : sent ? 'Sent' : 'Send' }}
      </button>
    </div>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </form>
</template>
