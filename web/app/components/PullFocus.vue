<script setup lang="ts">
import {Popover, PopoverButton, PopoverPanel} from '@headlessui/vue'
import type {OpenPull, Signal} from '#shared/roadmap'
import {focusNote} from '#shared/roadmap'

// Focus on this, on a row of the Pull requests page (ORR-607): a focus on the PR's issue, as the owner's, to the session
// on it (or one orrery picks, or starts when nobody's listening), the way Send back does on the issue's page (ORR-492).
// Its note is filled in from where the PR stands (`focusNote`), and shown first in a popover, so the owner can add a
// line before Send. Only for a PR that names an issue: one that doesn't has no issue to focus.
const props = defineProps<{pull: OpenPull, issue: NonNullable<OpenPull['issue']>}>()

const note = ref('')
const busy = ref(false)
const failed = ref('')
/** Who it reached, once sent; empty when nobody was listening (a session starts for it, or it waits for one). */
const sent = ref<string[] | null>(null)

/** The note as last filled in, so opening again keeps a line the owner added but follows a state that changed. */
let filled = ''
function fill() {
    if (!note.value.trim() || note.value === filled) note.value = filled = focusNote(props.pull)
    failed.value = ''
}
async function send(close: () => void) {
    // ⌘↵ comes here past Send's disabled state: not twice at once, and not with nothing to say.
    if (busy.value || !note.value.trim()) return
    busy.value = true
    failed.value = ''
    try {
        const {project, id} = props.issue
        const {signal} = await apiFetch<{signal: Signal}>(`/projects/${encodeURIComponent(project)}/issues/${encodeURIComponent(id)}/focus`, {
            method: 'POST', body: {note: note.value.trim(), start: true},
        })
        sent.value = signal.delivered_to
        note.value = ''
        close()
    } catch (error) {
        failed.value = errorMessage(error, 'send')
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <Popover v-slot="{close}" class="relative shrink-0">
    <PopoverButton as="template">
      <UiButton size="xs" :title="`Ask a session to work on ${issue.id} for this PR`" @click="fill">
        {{ sent ? (sent.length ? `Sent to ${sent.join(', ')}` : 'Sent') : 'Focus on this' }}
      </UiButton>
    </PopoverButton>
    <PopoverPanel class="menu absolute top-full right-0 z-40 mt-1.5 w-96 max-w-[calc(100vw-2rem)] gap-2 p-2" :aria-label="`Focus on ${issue.id}`">
      <form class="flex flex-col gap-2" @submit.prevent="send(close)">
        <p class="text-xs text-muted">
          A focus on <span class="font-mono">{{ issue.id }}</span>, to the session on it, or one orrery picks or starts:
        </p>
        <textarea
            v-model="note"
            rows="4"
            class="field w-full resize-y px-2 py-1.5 text-xs"
            aria-label="Note"
            @keydown.meta.enter.prevent="send(close)"
            @keydown.ctrl.enter.prevent="send(close)"
        />
        <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
        <div class="flex items-center gap-2">
          <KeyHint class="ml-auto">⌘↵</KeyHint>
          <UiButton type="submit" variant="primary" size="xs" :disabled="busy || !note.trim()">{{ busy ? 'Sending…' : 'Send' }}</UiButton>
        </div>
      </form>
    </PopoverPanel>
  </Popover>
</template>
