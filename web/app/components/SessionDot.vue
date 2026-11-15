<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {cutOffLabel} from '#shared/roadmap'

// A session's state as a dot: green idle, orange working, red pulsing when it needs the owner, amber when its last turn
// was cut off (a usage limit, say). Always in its state's colour (ORR-1207): a session whose channel can't hear a signal
// (not started with the channel flag) keeps it, faded, so the dot still tells working from idle.
defineProps<{session: Session}>()
</script>

<template>
  <span
      class="relative flex size-2 shrink-0"
      :data-state="session.cut_off ? 'cut-off' : session.state"
      :data-listening="session.listening ? 'yes' : 'no'"
      :title="session.cut_off ? cutOffLabel(session.cut_off) : session.listening ? session.state : `${session.state}, not listening`"
  >
    <span v-if="session.state === 'waiting'" class="absolute inline-flex size-full animate-ping rounded-full bg-rose-400 opacity-60" />
    <span
        data-session-dot
        class="relative inline-flex size-2 rounded-full"
        :class="[
            session.cut_off ? 'bg-amber-500' : {idle: 'bg-emerald-500', working: 'bg-accent-fill', waiting: 'bg-rose-500', starting: 'bg-faint'}[session.state],
            !session.listening && 'opacity-40',
        ]"
    />
  </span>
</template>
