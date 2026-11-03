<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// A board's file brought in as a new board (ORR-747), beside the export on a project's Settings; it never touches the
// board these settings are for. An id or key already taken is the server's to say, and then the file waits while you
// choose others.
const field = 'h-8 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
const router = useRouter()
const file = ref<File | null>(null)
const taken = ref(false)
const id = ref('')
const key = ref('')
const busy = ref(false)
const failed = ref('')

async function send() {
    if (!file.value || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        const query = {...id.value.trim() ? {id: id.value.trim()} : {}, ...key.value.trim() ? {key: key.value.trim()} : {}}
        const board = await apiFetch<Project>('/projects/upload', {method: 'POST', query, body: file.value})
        reset()
        router.push(`/p/${board.id}`)
    } catch (error) {
        failed.value = errorMessage(error, 'upload')
        taken.value = (error as {statusCode?: number}).statusCode === 409 || taken.value
    } finally {
        busy.value = false
    }
}
function chosen(event: Event) {
    const input = event.target as HTMLInputElement
    const picked = input.files?.[0] ?? null
    input.value = ''
    if (!picked) return
    reset()
    file.value = picked
    send()
}
function reset() {
    file.value = null
    taken.value = false
    id.value = ''
    key.value = ''
    failed.value = ''
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div>
      <label class="inline-flex cursor-pointer items-center rounded-md px-3 py-1.5 text-[13px] font-medium text-fg ring-1 ring-line focus-within:ring-accent-500/50 hover:bg-hover">
        {{ busy ? 'Uploading…' : 'Upload a board…' }}
        <input type="file" accept=".json,application/json" class="sr-only" :disabled="busy" @change="chosen">
      </label>
    </div>
    <form v-if="taken" class="flex flex-wrap items-end gap-2" @submit.prevent="send" @keydown.esc="reset">
      <label class="flex flex-col gap-1 text-xs text-muted">
        <span>New id</span>
        <input v-model="id" aria-label="New id" autocomplete="off" spellcheck="false" :class="[field, 'w-48']">
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        <span>New key</span>
        <input v-model="key" aria-label="New key" autocomplete="off" spellcheck="false" :class="[field, 'w-24 uppercase']" @input="key = key.toUpperCase()">
      </label>
      <UiButton type="submit" :disabled="busy">Upload</UiButton>
      <UiButton variant="ghost" @click="reset">Cancel</UiButton>
    </form>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
