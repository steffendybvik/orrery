<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// A row's or card's mark that a session is working the issue: its dot in the session's colours (as `SessionDot` has them), fading
// in and out while it works, its name on hover. Without the unseen dot's halo, so the two don't read alike.
defineProps<{session: Session}>()
</script>

<template>
  <span
      class="inline-flex size-2 shrink-0 rounded-full"
      :class="[{idle: 'bg-emerald-500', working: 'bg-accent-fill animate-pulse motion-reduce:animate-none', waiting: 'bg-rose-500', starting: 'bg-faint'}[session.state]]"
      role="img"
      :aria-label="`${session.name} is working on it`"
      :title="`${session.name} is working on it (${SESSION_STATE[session.state]})`"
  />
</template>
