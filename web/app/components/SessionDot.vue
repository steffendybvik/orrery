<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {cutOffLabel} from '#shared/roadmap'

// A session's state as a dot: green idle, orange working, red pulsing when it needs the owner, amber when its last turn
// was cut off (a usage limit, say); hollow when its channel isn't connected (it can't hear a signal).
defineProps<{session: Session}>()
</script>

<template>
  <span class="relative flex size-2 shrink-0" :title="session.cut_off ? cutOffLabel(session.cut_off) : session.listening ? session.state : `${session.state}, not listening`">
    <span v-if="session.state === 'waiting'" class="absolute inline-flex size-full animate-ping rounded-full bg-rose-400 opacity-60" />
    <span
        class="relative inline-flex size-2 rounded-full"
        :class="[
            session.cut_off ? 'bg-amber-500' : {idle: 'bg-emerald-500', working: 'bg-accent-fill', waiting: 'bg-rose-500', starting: 'bg-faint'}[session.state],
            !session.listening && 'bg-transparent ring-1 ring-inset ring-faint',
        ]"
    />
  </span>
</template>
