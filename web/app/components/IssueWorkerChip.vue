<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// Says which session is working the issue, on its page: its dot, its name and what it's doing, linking to it on the
// Sessions page (`useIssueWorker`).
defineProps<{session: Session}>()
const STATE = {idle: 'idle', working: 'working', waiting: 'needs you', starting: 'starting'}
</script>

<template>
  <NuxtLink
      :to="`/sessions#session-${session.id}`"
      class="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-[11px] text-muted ring-1 ring-line hover:bg-hover hover:text-fg"
      :title="`${session.name} is working on this issue; open it on the Sessions page`"
  >
    <SessionDot :session="session" />
    <span class="truncate text-fg">{{ session.name }}</span>
    <span :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">· {{ STATE[session.state] }}</span>
  </NuxtLink>
</template>
