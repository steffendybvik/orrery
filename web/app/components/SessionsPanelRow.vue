<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// One session in SessionsPanel: its state, a link to its card, and a button to point it at this issue or chunk.
defineProps<{session: Session, worker?: string, issue?: string, sending: string | null}>()
defineEmits<{focus: []}>()
</script>

<template>
  <li class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-2 hover:bg-hover">
    <SessionDot :session="session" />
    <NuxtLink
        :to="`/sessions#session-${session.id}`"
        class="min-w-0 truncate text-[13px] text-fg hover:underline"
        :title="`Open ${session.name} on the Sessions page`"
    >{{ session.name }}</NuxtLink>
    <span v-if="session.id === worker" class="rounded-full bg-accent-500/10 px-1.5 text-[11px] font-medium text-accent-700 ring-1 ring-accent-500/30 dark:text-accent-300">on this issue</span>
    <span class="whitespace-nowrap text-xs" :class="session.state === 'waiting' ? 'text-rose-700 dark:text-rose-400' : 'text-faint'">
      {{ SESSION_STATE[session.state] }} · {{ ago(session.since) }}
    </span>
    <button
        v-if="session.listening"
        type="button"
        class="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ring-1 transition-colors disabled:opacity-50"
        :class="session.state === 'idle' ? 'bg-accent-500/10 text-accent-700 ring-accent-500/40 hover:bg-accent-500/20 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
        :disabled="!!sending"
        :title="issue ? `Ask ${session.name} to work on this now` : `Ask ${session.name} to work through this chunk now`"
        @click="$emit('focus')"
    >
      {{ sending === session.id ? 'Sending…' : 'Focus on this' }}
    </button>
  </li>
</template>
