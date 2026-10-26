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

function onOutside(event: PointerEvent) {
    if (!root.value?.contains(event.target as Node)) open.value = false
}
watch(open, isOpen => isOpen ? document.addEventListener('pointerdown', onOutside) : document.removeEventListener('pointerdown', onOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside))
</script>

<template>
  <div v-if="listening.length && look(column).kind !== 'proposed' && !isClosed(look(column).kind)" ref="root" class="relative" @click.stop @keydown.stop @keydown.esc="open = false">
    <span v-if="note" class="text-xs text-faint">{{ note }}</span>
    <UiButton
        v-else
        size="xs"
        :aria-expanded="open"
        :disabled="sending"
        :title="`Ask the sessions to work through the ${label} issues, most urgent first`"
        @click="open = !open"
    >
      <svg class="size-3 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
      {{ sending ? 'Sending…' : `Focus on all ${label}` }}
    </UiButton>
    <div v-if="open" class="menu absolute top-full right-0 z-40 mt-1.5 w-56" role="menu">
      <UiMenuItem v-if="listening.length > 1" @click="focus(null)">All {{ listening.length }} sessions</UiMenuItem>
      <UiMenuItem
          v-for="session in listening"
          :key="session.id"
          @click="focus(session)"
      >
        <SessionDot :session="session" />
        <span class="min-w-0 flex-1 truncate">{{ session.name }}</span>
      </UiMenuItem>
    </div>
  </div>
</template>
