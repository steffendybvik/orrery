<script setup lang="ts">
import type {Column, Priority} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// Writing a new issue, as the owner (so agents can't delete it); Orrery hands out its id. Its labels say
// what kind it is (bug, feature request, …), and it can go straight to the listening Claude sessions to
// pick up. An image pasted, dropped or picked goes into the description as Markdown. ⌘↵ creates it and
// opens its page, Esc closes.
const {target, close} = useNewIssue()
const {byId} = useRoadmaps()
const {load} = useOwner()
const {open: openIssue} = useIssueLink()

const project = computed(() => byId(target.value?.project))
const chunks = computed(() => project.value?.board.chunks.filter(c => c.id) ?? [])
const title = ref('')
const notes = ref('')
const chunk = ref('')
const priority = ref<Priority | ''>('')
const labels = ref<string[]>([])
const column = ref<Column>('backlog')
const ask = ref(false)
// The kinds of issue, always offered, and the labels already in the project
const KINDS = ['bug', 'improvement', 'migration', 'feature request']
const known = computed(() => [...new Set([...KINDS, ...project.value ? allIssues(project.value).flatMap(({issue}) => issue.labels) : []])])
const saving = ref(false)
const failed = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
const notesInput = ref<HTMLTextAreaElement | null>(null)
const {uploading, failed: uploadError, dragging, upload, onPaste, onDrop} = useImageUpload(notes, notesInput)
// Where it starts: Proposed or any open status.
const {places} = useStatuses()
const WHERE = computed(() => places.value.filter(p => !isClosed(p.kind)))

watch(target, now => {
    if (!now) return
    title.value = ''
    notes.value = ''
    chunk.value = now.chunk ?? ''
    priority.value = ''
    labels.value = []
    column.value = WHERE.value.find(w => w.kind === 'backlog')?.id ?? 'backlog'
    ask.value = false
    failed.value = uploadError.value = ''
    nextTick(() => titleInput.value?.focus())
})

async function create() {
    if (!project.value || !title.value.trim() || saving.value || uploading.value) return
    saving.value = true
    failed.value = ''
    try {
        const owner = await load()
        const issue = await $fetch<{id: string}>(`/api/projects/${encodeURIComponent(project.value.id)}/issues`, {
            method: 'POST',
            headers: {'Orrery-Actor': owner},
            body: {
                ...labels.value.length ? {labels: labels.value} : {},
                title: title.value.trim(),
                ...notes.value.trim() ? {notes: notes.value.trim()} : {},
                ...chunk.value ? {chunk: chunk.value} : {},
                ...priority.value ? {priority: priority.value} : {},
                ...columnPatch(column.value),
            },
        })
        const id = project.value.id
        if (ask.value) {
            await $fetch(`/api/projects/${encodeURIComponent(id)}/issues/${encodeURIComponent(issue.id)}/focus`, {
                method: 'POST', headers: {'Orrery-Actor': owner}, body: {note: `A new ${labels.value.length ? labels.value.join(', ') : 'issue'}: please pick it up.`},
            }).catch(() => {})
        }
        close()
        openIssue(id, issue.id)
    } catch (error) {
        failed.value = errorMessage(error, 'create')
    } finally {
        saving.value = false
    }
}

const field = 'h-8 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <Teleport to="body">
    <div v-if="target && project" class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh] backdrop-blur-[2px]" @pointerdown.self="close">
      <form class="glass flex w-full max-w-2xl animate-fade-up flex-col gap-3 rounded-2xl p-5" role="dialog" aria-label="New issue" @submit.prevent="create" @keydown.esc.stop="close" @keydown.meta.enter.prevent="create" @keydown.ctrl.enter.prevent="create">
        <div class="flex items-center gap-2 text-xs text-faint">
          <span class="rounded bg-well px-1.5 py-px font-mono text-[10px] ring-1 ring-line">{{ project.key }}</span>
          <span>New in {{ project.name }}</span>
          <KeyHint class="ml-auto">esc</KeyHint>
        </div>
        <input ref="titleInput" v-model="title" placeholder="Issue title" aria-label="Title" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
        <div
            class="-mx-2 flex flex-col rounded-lg px-2 ring-1 ring-transparent"
            :class="dragging && 'ring-accent-500/50'"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
        >
          <textarea
              ref="notesInput"
              v-model="notes"
              rows="5"
              placeholder="Add a description… (Markdown works, paste or drop an image)"
              aria-label="Description"
              class="resize-y bg-transparent text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
              @paste="onPaste"
          />
          <div class="-ml-1.5 flex items-center gap-2">
            <ImageButton @picked="upload" />
            <span v-if="uploading" class="text-xs text-faint">Adding image…</span>
            <span v-else-if="uploadError" class="text-xs text-rose-600 dark:text-rose-400">{{ uploadError }}</span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <select v-model="column" aria-label="Where" :class="field">
            <option v-for="w in WHERE" :key="w.id" :value="w.id">{{ w.label }}</option>
          </select>
          <select v-model="priority" aria-label="Priority" :class="field">
            <option value="">No priority</option>
            <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }} · {{ PRIORITY_LABEL[p] }}</option>
          </select>
          <select v-model="chunk" aria-label="Chunk" :class="[field, 'max-w-56']">
            <option value="">No chunk</option>
            <option v-for="c in chunks" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
          <LabelPicker v-model="labels" :labels="known" />
          <label class="flex items-center gap-1.5 text-xs text-muted">
            <input v-model="ask" type="checkbox" class="accent-accent-500">
            Ask a Claude session to pick it up
          </label>
          <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <button type="submit" class="ml-auto flex h-8 items-center gap-2 rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="!title.trim() || saving || !!uploading">
            {{ saving ? 'Creating…' : 'Create issue' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
