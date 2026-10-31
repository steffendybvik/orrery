<script setup lang="ts">
import type {Column, Session} from '#shared/roadmap'
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'

// On a status group of a chunk's page: asks one listening session, or all of them, to work through the
// chunk's issues of that status, most urgent first. Only there while a session is listening. Headless UI's Menu
// does the keys, focus and outside-click.
const props = defineProps<{project: string, chunk: string, column: Column}>()
const {sessions: all} = useRoadmaps()

const listening = computed(() => (all.value[props.project] ?? []).filter(s => s.listening))
const {look} = useStatuses()
const label = computed(() => look(props.column).label)
const sending = ref(false)
const note = ref('')

async function focus(session: Session | null) {
    sending.value = true
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.project)}/chunks/${encodeURIComponent(props.chunk)}/focus`, {
            method: 'POST', body: {status: props.column, session: session?.id ?? '*'},
        })
        note.value = `Sent to ${session ? session.name : listening.value.length === 1 ? 'the session' : `${listening.value.length} sessions`}`
    } catch {
        note.value = "Couldn't send"
    } finally {
        sending.value = false
        setTimeout(() => note.value = '', 2500)
    }
}
</script>

<template>
  <Menu v-if="listening.length && look(column).kind !== 'proposed' && !isClosed(look(column).kind)" as="div" class="relative" @click.stop @keydown.stop>
    <span v-if="note" class="text-xs text-faint">{{ note }}</span>
    <MenuButton v-else as="template" :disabled="sending">
      <UiButton size="xs" :title="`Ask the sessions to work through the ${label} issues, most urgent first`">
        <svg class="size-3 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
        <UiBusy :busy="sending" label="Sending…">{{ `Focus on all ${label}` }}</UiBusy>
      </UiButton>
    </MenuButton>
    <MenuItems class="menu absolute top-full right-0 z-40 mt-1.5 w-56">
      <MenuItem v-if="listening.length > 1" v-slot="{active}" as="template">
        <UiMenuItem :lit="active" @click="focus(null)">All {{ listening.length }} sessions</UiMenuItem>
      </MenuItem>
      <MenuItem v-for="session in listening" :key="session.id" v-slot="{active}" as="template">
        <UiMenuItem :lit="active" @click="focus(session)">
          <SessionDot :session="session" />
          <span class="min-w-0 flex-1 truncate">{{ session.name }}</span>
        </UiMenuItem>
      </MenuItem>
    </MenuItems>
  </Menu>
</template>
