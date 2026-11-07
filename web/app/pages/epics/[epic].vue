<script setup lang="ts">
import type {Kinds, Signal} from '#shared/roadmap'
import {emptyKinds, numberOf, shownId} from '#shared/roadmap'

// An epic's page (ORR-895): its title and notes, edited in place, its progress across projects, and its issues in a
// section per project, by status (the board's filters would hide the done ones). The issues come from the boards the
// page already holds, each project read whole (closed issues and all) once the epic says it has issues there. It can
// be removed: its issues stay where they are, in no epic. Esc goes back to the epics.
const route = useRoute()
const router = useRouter()
const {projects, ready, whole} = useRoadmaps()
const {ordered} = useProjectOrder()
const {epics, failed: readFailed, load} = useLiveEpics()

// `/epics/1`, `/epics/EPC-1`, or the full id pasted in (ORR-995).
const id = computed(() => {
    const sent = String(route.params.epic)
    return Number(numberOf('epic', sent, '') ?? epics.value?.find(e => e.full_id?.toLowerCase() === sent.toLowerCase())?.id)
})
const epic = computed(() => epics.value?.find(e => e.id === id.value))
// The projects it has issues in, read whole so their done issues count here too.
watch(() => epic.value?.projects.map(p => p.project).join(','), () => {
    for (const part of epic.value?.projects ?? []) whole(part.project).catch(() => {})
}, {immediate: true})
// Each project's part, in the sidebar's order: from its board, so it moves as its issues do.
const parts = computed(() => ordered.value.flatMap(p => {
    const project = projects.value.find(q => q.id === p.id)
    if (!project) return []
    const milestones = epicMilestones(project, id.value)
    if (!milestones.length) return []
    const tasks = milestones.flatMap(c => c.tasks)
    const kinds = emptyKinds()
    tasks.forEach(issue => (Object.keys(kinds) as (keyof Kinds)[]).forEach(kind => kinds[kind] += issue.kinds[kind]))
    // Open issues first, then the closed ones, each keeping the board's order.
    const rows = milestones.flatMap(milestone => milestone.tasks.map(issue => ({issue, milestone})))
    rows.sort((a, b) => Number(isClosed(a.issue.kind)) - Number(isClosed(b.issue.kind)))
    return [{project, milestones, rows, issues: tasks.length, kinds}]
}))

const saving = ref(false)
const failed = ref('')
const api = computed(() => `/epics/${id.value}`)
async function save(body: Record<string, unknown>): Promise<boolean> {
    saving.value = true
    failed.value = ''
    try {
        await apiFetch(api.value, {method: 'PATCH', body})
        await load()
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        return false
    } finally {
        saving.value = false
    }
}

// The title, edited in place: Enter saves, Esc puts it back.
const editingTitle = ref(false)
const title = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
function editTitle() {
    title.value = epic.value?.title ?? ''
    editingTitle.value = true
    nextTick(() => titleInput.value?.select())
}
async function saveTitle() {
    if (!editingTitle.value) return
    const next = title.value.trim()
    if (next && next !== epic.value?.title && !await save({title: next})) return
    editingTitle.value = false
}

// The notes, in Markdown: ⌘↵ saves, Esc leaves them as they were.
const editingNotes = ref(false)
const notes = ref('')
const notesInput = ref<HTMLTextAreaElement | null>(null)
function editNotes() {
    notes.value = epic.value?.notes ?? ''
    editingNotes.value = true
    nextTick(() => notesInput.value?.focus())
}
async function saveNotes() {
    const next = notes.value.trim()
    if (next !== (epic.value?.notes ?? '') && !await save({notes: next || null})) return
    editingNotes.value = false
}
watch(id, () => editingTitle.value = editingNotes.value = false)

// Focus on this (ORR-987): a focus on the epic's open issues for each project it has some in, to one session there
// orrery picks, or starts when nobody's listening, as an issue's Focus on this does.
// Where it has open work, by its issues' columns (a parent's, its sub-issues'): each project with some, and the
// open statuses they're in, in the boards' order, for the Sessions panel (ORR-958).
const {columns: allColumns, look} = useStatuses()
const working = (column: string) => look(column).kind !== 'proposed' && !isClosed(look(column).kind)
const openIn = (part: (typeof parts.value)[number]) => part.rows.flatMap(({issue}) => Object.entries(issue.counts).filter(([column, n]) => n && working(column)).map(([column]) => column))
const openProjects = computed(() => parts.value.filter(part => openIn(part).length).map(part => part.project.id))
const openColumns = computed(() => {
    const found = new Set(parts.value.flatMap(openIn))
    return allColumns.value.map(l => l.id).filter(id => found.has(id))
})
const open = computed(() => openProjects.value.length > 0)
const focusing = ref(false)
const focused = ref('')
async function focus() {
    focusing.value = true
    failed.value = ''
    try {
        const {signals} = await apiFetch<{signals: Signal[]}>(`${api.value}/focus`, {method: 'POST', body: {start: true}})
        focused.value = signals.length === 1 ? `Sent to ${signals[0]?.project}` : `Sent to ${signals.length} projects`
        setTimeout(() => focused.value = '', 4000)
    } catch (error) {
        failed.value = errorMessage(error, 'send')
    } finally {
        focusing.value = false
    }
}

const confirmingRemove = ref(false)
async function remove() {
    saving.value = true
    failed.value = ''
    try {
        await apiFetch(api.value, {method: 'DELETE'})
        await load()
        router.push('/epics')
    } catch (error) {
        failed.value = errorMessage(error, 'remove')
    } finally {
        saving.value = false
        confirmingRemove.value = false
    }
}

function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (event.key !== 'Escape' || useState('palette-open').value) return
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    router.push('/epics')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

useHead(() => ({title: epic.value ? `${epic.value.title} · Epics · orrery` : 'orrery'}))
</script>

<template>
  <PageHeader>
    <UiButton to="/epics" variant="ghost" size="xs" square class="-ml-1 max-md:hidden" title="Back to the epics (Esc)" aria-label="Back">
      <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
    </UiButton>
    <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      <NuxtLink to="/epics" class="shrink-0 font-medium hover:text-fg">Epics</NuxtLink>
      <template v-if="epic">
        <span class="text-faint">/</span>
        <span class="truncate text-fg">{{ epic.title }}</span>
      </template>
    </nav>
  </PageHeader>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <template v-if="epic">
      <header class="mx-auto flex max-w-5xl animate-fade-up flex-col gap-4 px-4 pt-8 pb-6 sm:px-8">
        <div class="flex flex-wrap items-center gap-3 text-xs">
          <span class="flex items-center gap-1.5">
            <span class="font-mono text-faint" data-testid="epic-id">{{ shownId('epic', epic.id) }}</span>
            <!-- Its full id, with the server's uid, as an issue's copies (ORR-995); the tools and the API take it as they take `1`. -->
            <CopyButton :text="epic.full_id ?? shownId('epic', epic.id)" :name="epic.full_id ?? shownId('epic', epic.id)" />
          </span>
          <span class="ml-auto flex items-center gap-2">
            <span v-if="focused" class="text-faint" role="status">{{ focused }}</span>
            <UiButton
                v-else-if="open && !confirmingRemove"
                size="xs"
                :disabled="focusing"
                title="Ask a session in each project to work through the epic's open issues, most urgent first (starts one where nobody's listening)"
                @click="focus"
            >
              <svg class="size-3 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
              <UiBusy :busy="focusing" label="Sending…">Focus on this</UiBusy>
            </UiButton>
            <UiConfirm v-if="confirmingRemove" inline :busy="saving" @confirm="remove" @cancel="confirmingRemove = false">
              Remove this epic? Its {{ epic.issues }} {{ epic.issues === 1 ? 'issue stays' : 'issues stay' }} where {{ epic.issues === 1 ? 'it is' : 'they are' }}, in no epic.
            </UiConfirm>
            <UiButton
                v-else
                variant="danger-ghost"
                size="xs"
                square
                title="Remove this epic"
                aria-label="Remove this epic"
                @click="confirmingRemove = true"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            </UiButton>
          </span>
        </div>
        <input
            v-if="editingTitle"
            ref="titleInput"
            v-model="title"
            aria-label="Title"
            class="h-10 w-full rounded-md bg-well px-2 text-xl font-semibold tracking-tight text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none sm:text-2xl"
            :disabled="saving"
            @keydown.enter.prevent="saveTitle"
            @keydown.esc.stop.prevent="editingTitle = false"
            @blur="saveTitle"
        >
        <h1 v-else class="text-xl font-semibold tracking-tight text-fg sm:text-2xl">
          <button type="button" class="rounded-md text-left hover:bg-hover" title="Click to edit" @click="editTitle">{{ epic.title }}</button>
        </h1>

        <section v-if="editingNotes" class="flex flex-col gap-2" @keydown.esc.stop.prevent="editingNotes = false">
          <textarea
              ref="notesInput"
              v-model="notes"
              aria-label="Notes"
              placeholder="What it's about, in Markdown"
              rows="4"
              class="field-sizing-content min-h-24 w-full resize-y rounded-xl bg-well px-4 py-3 font-mono text-[13px] leading-6 text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              :disabled="saving"
              @keydown.meta.enter.prevent="saveNotes"
              @keydown.ctrl.enter.prevent="saveNotes"
          />
          <div class="flex items-center justify-end gap-2">
            <span class="mr-auto text-xs text-faint">Markdown</span>
            <UiButton :disabled="saving" @click="editingNotes = false">Cancel <KeyHint>esc</KeyHint></UiButton>
            <UiButton variant="primary" :disabled="saving" @click="saveNotes">
              <UiBusy :busy="saving" label="Saving…">Save</UiBusy> <KeyHint class="bg-black/10 text-on-accent ring-0">⌘↵</KeyHint>
            </UiButton>
          </div>
        </section>
        <section v-else class="group relative">
          <UiButton
              v-if="epic.notes"
              class="absolute -top-1 right-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              @click="editNotes"
          >Edit</UiButton>
          <MarkdownView v-if="epic.notes" :source="epic.notes" />
          <button v-else type="button" class="text-sm text-faint italic hover:text-muted" @click="editNotes">No notes. Add some</button>
        </section>
        <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>

        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-faint">
          <ProgressRing :kinds="epic.kinds" :size="16" />
          <span>{{ epic.issues }} {{ epic.issues === 1 ? 'issue' : 'issues' }}<template v-if="epic.projects.length"> in {{ epic.projects.length }} {{ epic.projects.length === 1 ? 'project' : 'projects' }}</template></span>
        </div>
      </header>
      <!-- Who can take it (ORR-958): the sessions on its projects, to point one or all at it, or at one status. -->
      <div v-if="open" class="mx-auto max-w-5xl px-4 pb-6 sm:px-8">
        <EpicSessions :epic="epic.id" :projects="openProjects" :columns="openColumns" />
      </div>
      <!-- Each project's issues as children of the epic (ORR-955), laid out like an issue's sub-issues: a heading with
           its progress, then the issues as one compact list, in the header's column. -->
      <div v-if="parts.length" class="mx-auto flex max-w-5xl flex-col gap-6 px-4 pb-10 sm:px-8">
        <section v-for="part in parts" :key="part.project.id" class="flex flex-col gap-2" :aria-label="part.project.name">
          <h2 class="label flex items-center gap-2">
            <NuxtLink :to="`/p/${part.project.id}`" class="hover:text-fg">{{ part.project.name }}</NuxtLink>
            <ProgressRing :kinds="part.kinds" :size="13" />
            <span class="font-mono normal-case">{{ part.kinds.done }}/{{ part.issues }}</span>
          </h2>
          <div class="overflow-hidden rounded-xl border border-line dark:bg-panel">
            <IssueRow
                v-for="{issue, milestone} in part.rows"
                :key="issue.id"
                :issue="issue"
                :project="part.project.id"
                :milestone="milestone"
                nested
            />
          </div>
        </section>
      </div>
      <p v-if="!parts.length" class="px-4 py-16 text-center text-sm text-muted">No issues in this epic yet. Pick it under Epic on an issue’s page, in any project.</p>
      <!-- Words on the epic (ORR-977), read again as it changes. -->
      <div class="mx-auto max-w-5xl px-4 pb-10 sm:px-8">
        <ThreadComments :url="`${api}/comments`" :reload="epic.updated_at" />
      </div>
    </template>
    <NotFound v-else-if="ready && epics" to="/epics" back="Back to the epics">No epic “{{ route.params.epic }}”</NotFound>
    <UiLoading v-else :failed="readFailed" what="the epic" @retry="load" />
  </div>
</template>
