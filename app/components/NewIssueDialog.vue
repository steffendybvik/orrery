<script setup lang="ts">
import type {Column, Priority} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// Writing a new issue, as the owner (so agents can't delete it); Orrery hands out its id. A feature or
// change request is labelled as one, and can go straight to the listening Claude sessions to pick up.
// ⌘↵ creates it and opens its page, Esc closes.
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
const column = ref<Exclude<Column, 'done'>>('backlog')
const kind = ref<'issue' | 'feature request' | 'change request'>('issue')
const ask = ref(false)
watch(kind, now => ask.value = now !== 'issue')
const KINDS = [{value: 'issue' as const, label: 'Issue'}, {value: 'feature request' as const, label: 'Feature request'}, {value: 'change request' as const, label: 'Change request'}]
const saving = ref(false)
const failed = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
const WHERE: {value: Exclude<Column, 'done'>, label: string}[] = [
    {value: 'backlog', label: 'Backlog'}, {value: 'later', label: 'Later'}, {value: 'next', label: 'Next'},
    {value: 'now', label: 'Now'}, {value: 'doing', label: 'Doing'},
]

watch(target, now => {
    if (!now) return
    title.value = ''
    notes.value = ''
    chunk.value = now.chunk ?? ''
    priority.value = ''
    column.value = 'backlog'
    kind.value = 'issue'
    ask.value = false
    failed.value = ''
    nextTick(() => titleInput.value?.focus())
})

async function create() {
    if (!project.value || !title.value.trim() || saving.value) return
    saving.value = true
    failed.value = ''
    try {
        const plan = column.value === 'backlog' || column.value === 'doing' ? undefined : column.value
        const owner = await load()
        const issue = await $fetch<{id: string}>(`/api/projects/${encodeURIComponent(project.value.id)}/issues`, {
            method: 'POST',
            headers: {'Orrery-Actor': owner},
            body: {
                ...kind.value !== 'issue' ? {labels: [kind.value]} : {},
                title: title.value.trim(),
                ...notes.value.trim() ? {notes: notes.value.trim()} : {},
                ...chunk.value ? {chunk: chunk.value} : {},
                ...priority.value ? {priority: priority.value} : {},
                ...plan ? {plan} : {},
                ...column.value === 'doing' ? {status: 'doing'} : {},
            },
        })
        const id = project.value.id
        if (ask.value) {
            await $fetch(`/api/projects/${encodeURIComponent(id)}/issues/${encodeURIComponent(issue.id)}/focus`, {
                method: 'POST', headers: {'Orrery-Actor': owner}, body: kind.value !== 'issue' ? {note: `A new ${kind.value}: please pick it up.`} : {},
            }).catch(() => {})
        }
        close()
        openIssue(id, issue.id)
    } catch (error) {
        failed.value = (error as {data?: {message?: string}}).data?.message ?? "Couldn't create it. Is Orrery running?"
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
        <SegmentedControl v-model="kind" :options="KINDS" class="self-start" />
        <input ref="titleInput" v-model="title" placeholder="Issue title" aria-label="Title" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
        <textarea v-model="notes" rows="5" placeholder="Add a description… (Markdown works)" aria-label="Description" class="resize-y bg-transparent text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none" />
        <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <select v-model="column" aria-label="Where" :class="field">
            <option v-for="w in WHERE" :key="w.value" :value="w.value">{{ w.label }}</option>
          </select>
          <select v-model="priority" aria-label="Priority" :class="field">
            <option value="">No priority</option>
            <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }} · {{ PRIORITY_LABEL[p] }}</option>
          </select>
          <select v-model="chunk" aria-label="Chunk" :class="[field, 'max-w-56']">
            <option value="">No chunk</option>
            <option v-for="c in chunks" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
          <label class="flex items-center gap-1.5 text-xs text-muted">
            <input v-model="ask" type="checkbox" class="accent-accent-500">
            Ask a Claude session to pick it up
          </label>
          <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <button type="submit" class="ml-auto flex h-8 items-center gap-2 rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="!title.trim() || saving">
            {{ saving ? 'Creating…' : kind === 'issue' ? 'Create issue' : `Send ${kind}` }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
