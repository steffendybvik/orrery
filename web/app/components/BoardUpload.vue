<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// A board's file brought in as a new board (ORR-747), from App settings (ORR-1248): it never touches a board that's
// here already. An id or key already taken is the server's to say, and then the file waits while you choose others.
// Its images can be left out, as they're most of a big board's file: a proxy in front of a hosted orrery refuses a
// body past its cap (413) before orrery sees it, and then that's the way through.
const field = 'h-8 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
const router = useRouter()
const file = ref<File | null>(null)
const bare = ref(false)
const taken = ref(false)
const tooBig = ref(false)
const id = ref('')
const key = ref('')
const busy = ref(false)
const failed = ref('')

/** The file as it goes: whole, or with its images left out. */
async function bodyOf(picked: File): Promise<File | string> {
    if (!bare.value) return picked
    let parsed: unknown
    try {
        parsed = JSON.parse(await picked.text())
    } catch {
        return picked
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as {uploads?: unknown}).uploads)) return picked
    return JSON.stringify({...parsed, uploads: []})
}

async function send() {
    if (!file.value || busy.value) return
    busy.value = true
    failed.value = ''
    tooBig.value = false
    try {
        const query = {...id.value.trim() ? {id: id.value.trim()} : {}, ...key.value.trim() ? {key: key.value.trim()} : {}}
        const board = await apiFetch<Project>('/projects/upload', {method: 'POST', query, body: await bodyOf(file.value)})
        reset()
        router.push(`/p/${board.id}`)
    } catch (error) {
        const status = (error as {statusCode?: number}).statusCode
        taken.value = status === 409 || taken.value
        tooBig.value = status === 413
        failed.value = status === 413 ? refusedAsTooBig(file.value) : errorMessage(error, 'upload')
    } finally {
        busy.value = false
    }
}
function refusedAsTooBig(picked: File | null) {
    const size = picked ? `${Math.max(1, Math.round(picked.size / 1024 / 1024))} MB` : 'this size'
    return bare.value
        ? `This orrery took no file of ${size}, even with its images left out. Something in front of it, such as a proxy, caps what one request can carry: upload it where orrery is reached directly, or ask whoever runs it to raise the cap.`
        : `This orrery took no file of ${size}: something in front of it, such as a proxy, caps what one request can carry. Its images are most of a big board's file, so upload it without them.`
}
function withoutImages() {
    bare.value = true
    send()
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
    tooBig.value = false
    id.value = ''
    key.value = ''
    failed.value = ''
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-3">
      <label class="inline-flex cursor-pointer items-center rounded-md px-3 py-1.5 text-[13px] font-medium text-fg ring-1 ring-line focus-within:ring-accent-500/50 hover:bg-hover">
        {{ busy ? 'Uploading…' : 'Upload a board…' }}
        <input type="file" accept=".json,application/json" class="sr-only" :disabled="busy" @change="chosen">
      </label>
      <label class="flex items-center gap-2 text-[13px] text-fg">
        <input v-model="bare" type="checkbox" class="accent-accent-fill" :disabled="busy">
        Leave out its images
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
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400" role="alert">{{ failed }}</p>
    <div v-if="tooBig && !bare && file" class="flex flex-wrap items-center gap-2">
      <UiButton :disabled="busy" @click="withoutImages">Upload it without images</UiButton>
      <UiButton variant="ghost" @click="reset">Cancel</UiButton>
    </div>
  </div>
</template>
