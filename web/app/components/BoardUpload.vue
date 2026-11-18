<script setup lang="ts">
import type {Project} from '#shared/roadmap'
import * as boards from '#shared/import-orrery.mjs'

// A board's file brought in as a new board (ORR-747), from App settings (ORR-1248): it never touches a board that's
// here already. An id or key already taken is the server's to say, and then the file waits while you choose others.
// It goes as a move sends one (ORR-1257): each image on its own, then the board, then its comments, events and doc
// history in parts, so a proxy's cap on one request and a small server's memory both hold for a board of any size.
const {sendBoard} = boards as unknown as {sendBoard: (target: unknown, file: unknown, options: {id?: string, key?: string}) => Promise<Project>}
const field = 'h-8 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
const router = useRouter()
const file = ref<File | null>(null)
const taken = ref(false)
const id = ref('')
const key = ref('')
const busy = ref(false)
const failed = ref('')

/** This orrery, as `sendBoard` asks it. */
const here = {
    post: (path: string, body: unknown) => apiFetch(path, {method: 'POST', body: body as Record<string, unknown>}),
    // JSON as a Blob of that type, not a header of its own: a call's own headers stand in for the actor apiFetch adds,
    // and the server takes a board only from the owner (ORR-1299).
    upload: (path: string, text: string) => apiFetch(path, {method: 'POST', body: new Blob([text], {type: 'application/json'})}),
}

/** The file read, or the file itself when it isn't JSON, for the server to say why it's no board. */
async function bodyOf(picked: File): Promise<unknown> {
    try {
        return JSON.parse(await picked.text())
    } catch {
        return undefined
    }
}

async function send() {
    if (!file.value || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        const as = {...id.value.trim() ? {id: id.value.trim()} : {}, ...key.value.trim() ? {key: key.value.trim()} : {}}
        const parsed = await bodyOf(file.value)
        const board = parsed && typeof parsed === 'object'
            ? await sendBoard(here, parsed, as)
            : await apiFetch<Project>('/projects/upload', {method: 'POST', query: as, body: file.value})
        reset()
        router.push(`/p/${board.id}`)
    } catch (error) {
        const status = (error as {statusCode?: number}).statusCode
        taken.value = status === 409 || taken.value
        failed.value = status === 413 ? refusedAsTooBig() : errorMessage(error, 'upload')
    } finally {
        busy.value = false
    }
}
function refusedAsTooBig() {
    return 'This orrery took none of it: something in front of it, such as a proxy, caps what one request can carry below even the board without its comments. Upload it where orrery is reached directly, or ask whoever runs it to raise the cap.'
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
    <div class="flex flex-wrap items-center gap-3">
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
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400" role="alert">{{ failed }}</p>
  </div>
</template>
