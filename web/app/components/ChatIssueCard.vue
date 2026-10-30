<script setup lang="ts">
import type {ChatIssueRequest} from '#shared/roadmap'

// In the chat (ChatPane): an issue it offers to file though the owner didn't ask for one (ORR-711), so they can see nothing
// has been filed, and file it with a press. Its text is shown as written, never rendered, so nothing in the Markdown can hide.
const props = defineProps<{request: ChatIssueRequest, project: string, busy: boolean, ended: boolean}>()
const emit = defineEmits<{decide: [file: boolean]}>()

const details = computed(() => [props.request.priority, props.request.chunk && `chunk ${props.request.chunk}`, ...props.request.labels ?? []].filter(Boolean).join(' · '))
const answered = computed(() => ({asked: 'Not filed', denied: 'Not filed: you said not to', expired: 'Not filed: not answered in time, or offered again', allowed: 'Filed'})[props.request.state])
</script>

<template>
  <div class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="`Offer to file ${request.title}`">
    <span class="text-xs text-faint">{{ request.state === 'asked' && !ended ? 'Offers to file an issue: nothing is filed yet' : 'An issue it offered' }}</span>
    <span class="font-medium break-words text-fg">{{ request.title }}</span>
    <span v-if="details" class="text-xs text-muted">{{ details }}</span>
    <div v-if="request.notes" class="max-h-80 overflow-auto rounded-lg bg-panel p-2 font-mono text-xs break-words whitespace-pre-wrap text-fg ring-1 ring-line">{{ request.notes }}</div>
    <div v-if="request.state === 'asked' && !ended" class="flex gap-2">
      <UiButton variant="primary" size="sm" :disabled="busy" @click="emit('decide', true)">File issue</UiButton>
      <UiButton size="sm" :disabled="busy" @click="emit('decide', false)">Don't file</UiButton>
    </div>
    <span v-else-if="request.state === 'allowed'" class="text-xs text-emerald-600 dark:text-emerald-400">
      Filed as <NuxtLink v-if="request.id" :to="`/p/${project}/issues/${request.id}`" class="font-mono underline underline-offset-2">{{ request.id }}</NuxtLink>
    </span>
    <span v-else class="text-xs text-faint">{{ answered }}</span>
  </div>
</template>
