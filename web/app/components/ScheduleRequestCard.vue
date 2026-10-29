<script setup lang="ts">
import type {ChatScheduleRequest} from '#shared/roadmap'
import {CHAT_SCHEDULE_FIELDS, scheduleValue} from '#shared/roadmap'

// A session asking the owner to make a schedule or change one, field by field (from → to for a change), with Allow and
// Deny while it's asked and `answerable`: in the chat (ChatPane), and on the issue a working session asked on (ORR-458).
const props = withDefaults(defineProps<{request: ChatScheduleRequest, answerable?: boolean, busy?: boolean, expired?: string}>(), {
    answerable: true,
    expired: 'Expired: not answered in time, or asked again',
})
defineEmits<{answer: [allow: boolean]}>()

const change = computed(() => props.request.changes.some(c => c.from !== undefined))
const answered = computed(() => ({allowed: 'Allowed and saved', denied: 'Denied: nothing changed', expired: props.expired, asked: 'Not answered'})[props.request.state])
</script>

<template>
  <div class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="change ? `Change schedule ${request.title}` : `Make schedule ${request.title}`">
    <span class="text-xs text-faint">{{ change ? `Asks to change schedule ${request.id}` : 'Asks to make a schedule' }}</span>
    <span class="font-medium text-fg">{{ request.title }}</span>
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      <template v-for="c in request.changes.filter(c => c.field !== 'title' || c.from !== undefined)" :key="c.field">
        <dt class="text-muted">{{ CHAT_SCHEDULE_FIELDS[c.field] }}</dt>
        <dd class="min-w-0 break-words whitespace-pre-wrap text-fg">
          <template v-if="c.from !== undefined"><span class="text-muted line-through decoration-faint">{{ scheduleValue(c.from) }}</span> → </template>{{ scheduleValue(c.to) }}
        </dd>
      </template>
    </dl>
    <div v-if="request.state === 'asked' && answerable" class="flex gap-2">
      <UiButton variant="primary" size="sm" :disabled="busy" @click="$emit('answer', true)">Allow</UiButton>
      <UiButton size="sm" :disabled="busy" @click="$emit('answer', false)">Deny</UiButton>
    </div>
    <span v-else class="text-xs" :class="request.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ answered }}</span>
  </div>
</template>
