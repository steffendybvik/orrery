<script setup lang="ts">
import type {Asks} from '#shared/roadmap'

// Says an issue waits on the owner: an agent asked for a decision or feedback, and no comment of theirs has come
// since (`issue.waiting`). On rows, cards, the issue page and Notifications; it goes once they comment. With
// `proposal` (its choices' count), an agent's proposal waiting on them, until they decide it.
const props = defineProps<{asks: Asks, proposal?: {choices: number}}>()
const label = computed(() => props.proposal
    ? `Proposal: needs your decision${props.proposal.choices ? ` · ${props.proposal.choices} ${props.proposal.choices === 1 ? 'choice' : 'choices'}` : ''}`
    : props.asks === 'decision' ? 'Needs your decision' : 'Needs your feedback')
const title = computed(() => props.proposal
    ? "An agent's proposal waits on you: approve it, ask for changes or reject it"
    : props.asks === 'decision' ? 'An agent asked for your decision: answer with a comment' : 'An agent asked for your feedback: answer with a comment')
</script>

<template>
  <span
      class="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-violet-500/15 px-2 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-500/40 dark:text-violet-300"
      :title="title"
  >
    <span class="size-1.5 rounded-full bg-violet-500" />
    {{ label }}
  </span>
</template>
