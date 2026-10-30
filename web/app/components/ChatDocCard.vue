<script setup lang="ts">
import type {ChatDocRequest} from '#shared/roadmap'
import {settingValue} from '#shared/roadmap'

// In the chat (ChatPane): a doc it asks to make or change (ORR-661), with Allow and Deny while it's asked. Making one shows
// the title, section and full text; changing one shows what changes, the text as a diff rather than the whole page. All of
// it as written, never rendered, so nothing in the Markdown can hide from the owner. Nothing is saved until they allow it.
const props = defineProps<{request: ChatDocRequest, busy: boolean, ended: boolean}>()
const emit = defineEmits<{decide: [allow: boolean]}>()

const heading = computed(() => props.request.was ? `Asks to change doc ${props.request.id}` : 'Asks to make a doc')
const label = computed(() => props.request.was ? `Change doc ${props.request.title}` : `Make doc ${props.request.title}`)
const answered = computed(() => {
    if (props.request.stale) return 'Refused: the doc changed after it asked, so nothing was saved'
    return {asked: 'Not answered', allowed: 'Allowed and saved', denied: 'Denied: nothing changed', expired: 'Expired: not answered in time, or asked again'}[props.request.state]
})
</script>

<template>
  <div class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="label">
    <span class="text-xs text-faint">{{ heading }}</span>
    <span class="font-medium break-words text-fg">
      <template v-if="request.was && request.body.title !== undefined"><span class="font-normal text-muted line-through decoration-faint">{{ request.was.title }}</span> → </template>{{ request.title }}
    </span>
    <dl v-if="request.body.section !== undefined" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      <dt class="text-muted">Section</dt>
      <dd class="min-w-0 break-words text-fg">
        <template v-if="request.was"><span class="text-muted line-through decoration-faint">{{ settingValue(request.was.section) }}</span> → </template>{{ settingValue(request.body.section) }}
      </dd>
    </dl>
    <DocDiff v-if="request.was && request.body.body !== undefined" :from="request.was.body" :to="request.body.body" class="max-h-80" />
    <div v-else-if="!request.was && request.body.body" class="max-h-80 overflow-auto rounded-lg bg-panel p-2 font-mono text-xs break-words whitespace-pre-wrap text-fg ring-1 ring-line" tabindex="0" data-testid="doc-text">{{ request.body.body }}</div>
    <div v-if="request.state === 'asked' && !ended" class="flex gap-2">
      <UiButton variant="primary" size="sm" :disabled="busy" @click="emit('decide', true)">Allow</UiButton>
      <UiButton size="sm" :disabled="busy" @click="emit('decide', false)">Deny</UiButton>
    </div>
    <span v-else class="text-xs" :class="request.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ answered }}</span>
  </div>
</template>
