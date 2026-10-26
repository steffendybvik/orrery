<script setup lang="ts">
import type {Column, Session} from '#shared/roadmap'

// On a status group of a chunk's page: asks one listening session, or all of them, to work through the
// chunk's issues of that status, most urgent first. Only there while a session is listening.
const props = defineProps<{project: string, chunk: string, column: Column}>()
const {sessions: all} = useRoadmaps()
const {load} = useOwner()

const listening = computed(() => (all.value[props.project] ?? []).filter(s => s.listening))
const {look} = useStatuses()
const label = computed(() => look(props.column).label)
const open = ref(false)
const sending = ref(false)
const note = ref('')
const root = ref<HTMLElement | null>(null)

async function focus(session: Session | null) {
    sending.value = true
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.project)}/chunks/${encodeURIComponent(props.chunk)}/focus`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {status: props.column, ...session ? {session: session.id} : {}},
        })
        note.value = `Sent to ${session ? session.name : listening.value.length === 1 ? 'the session' : `${listening.value.length} sessions`}`
    } catch {
        note.value = "Couldn't send"
    } finally {
        sending.value = false
        open.value = false
        setTimeout(() => note.value = '', 2500)
    }
}

useDismiss(root, () => open.value, () => open.value = false)
</script>

<template>
  <div v-if="listening.length && look(column).kind !== 'proposed' && !isClosed(look(column).kind)" ref="root" class="relative" @click.stop @keydown.stop @keydown.esc="open = false">
    <span v-if="note" class="text-xs text-faint">{{ note }}</span>
    <button
        v-else
        type="button"
        class="flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50"
        :aria-expanded="open"
        :disabled="sending"
        :title="`Ask the sessions to work through the ${label} issues, most urgent first`"
        @click="open = !open"
    >
      <svg class="size-3 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
      {{ sending ? 'Sending…' : `Focus on all ${label}` }}
    </button>
    <div v-if="open" class="glass absolute top-full right-0 z-40 mt-1.5 w-56 animate-fade-up rounded-xl p-1" role="menu">
      <button
          v-if="listening.length > 1"
          type="button"
          class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
          @click="focus(null)"
      >All {{ listening.length }} sessions</button>
      <button
          v-for="session in listening"
          :key="session.id"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
          @click="focus(session)"
      >
        <SessionDot :session="session" />
        <span class="min-w-0 flex-1 truncate">{{ session.name }}</span>
      </button>
    </div>
  </div>
</template>
