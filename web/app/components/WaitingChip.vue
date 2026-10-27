<script setup lang="ts">
import type {Asks} from '#shared/roadmap'

// Says an issue waits on the owner: an agent asked for a decision or feedback, and no comment of theirs has come
// since (`issue.waiting`). On rows, cards and the issue page; it goes once they comment.
defineProps<{asks: Asks}>()
</script>

<template>
  <span
      class="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-violet-500/15 px-2 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-500/40 dark:text-violet-300"
      :title="asks === 'decision' ? 'An agent asked for your decision: answer with a comment' : 'An agent asked for your feedback: answer with a comment'"
  >
    <span class="size-1.5 rounded-full bg-violet-500" />
    {{ asks === 'decision' ? 'Needs your decision' : 'Needs your feedback' }}
  </span>
</template>
