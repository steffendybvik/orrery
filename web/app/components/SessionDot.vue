<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// A session's state as a dot: green idle, orange working, red pulsing when it needs the owner; hollow
// when its channel isn't connected (it can't hear a signal).
defineProps<{session: Session}>()
</script>

<template>
  <span class="relative flex size-2 shrink-0" :title="session.listening ? session.state : `${session.state}, not listening`">
    <span v-if="session.state === 'waiting'" class="absolute inline-flex size-full animate-ping rounded-full bg-rose-400 opacity-60" />
    <span
        class="relative inline-flex size-2 rounded-full"
        :class="[
            {idle: 'bg-emerald-500', working: 'bg-accent-500', waiting: 'bg-rose-500', starting: 'bg-faint'}[session.state],
            !session.listening && 'bg-transparent ring-1 ring-inset ring-faint',
        ]"
    />
  </span>
</template>
