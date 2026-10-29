<script setup lang="ts">
import type {ChatSessionRequest} from '#shared/roadmap'

// In the chat (ChatPane): a session it asks to start, stop or give more time (ORR-509), with Allow and Deny while it's
// asked. Starting shows what Start session would be given: the project, what it's focused on, presets and the owner's
// words. Nothing happens until the owner allows it.
const props = defineProps<{request: ChatSessionRequest, busy: boolean, ended: boolean}>()
const emit = defineEmits<{decide: [allow: boolean]}>()

const heading = computed(() => ({start: 'Asks to start a session', stop: 'Asks to stop a session', extend: 'Asks to give a session more time'})[props.request.action])
const focus = computed(() => {
    const start = props.request.start
    if (start?.issue) return start.issue
    if (start?.statuses || start?.release) return `${start.statuses?.join(', ') ?? 'Todo and In progress'}${start.release ? ` in ${start.release}` : ''}`
    return 'Nothing in particular'
})
const DONE = {allowed: {start: 'Allowed: starting', stop: 'Allowed: stopping', extend: 'Allowed: given more time'}, denied: 'Denied: nothing happened', expired: 'Expired: not answered in time, or asked again'}
const answered = computed(() => props.request.state === 'allowed' ? DONE.allowed[props.request.action] : props.request.state === 'asked' ? 'Not answered' : DONE[props.request.state])
</script>

<template>
  <div class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="heading">
    <span class="text-xs text-faint">{{ heading }}</span>
    <dl v-if="request.action === 'start'" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      <dt class="text-muted">Project</dt><dd class="text-fg">{{ request.project }}</dd>
      <dt class="text-muted">On</dt><dd class="text-fg">{{ focus }}</dd>
      <template v-if="request.presets?.length"><dt class="text-muted">Presets</dt><dd class="text-fg">{{ request.presets.join(', ') }}</dd></template>
      <template v-if="request.start?.instructions"><dt class="text-muted">Your words</dt><dd class="min-w-0 break-words whitespace-pre-wrap text-fg">{{ request.start.instructions }}</dd></template>
    </dl>
    <span v-else class="text-fg"><span class="font-medium">{{ request.name }}</span><template v-if="request.action === 'extend'">: {{ request.minutes }} more minutes</template></span>
    <div v-if="request.state === 'asked' && !ended" class="flex gap-2">
      <UiButton variant="primary" size="sm" :disabled="busy" @click="emit('decide', true)">Allow</UiButton>
      <UiButton size="sm" :disabled="busy" @click="emit('decide', false)">Deny</UiButton>
    </div>
    <span v-else class="text-xs" :class="request.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ answered }}</span>
  </div>
</template>
