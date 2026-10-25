<script setup lang="ts">
import type {Comment, Issue} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// An issue's own page: its title and full description, sub-issues and activity, with its
// properties beside them. The title and description edit in place, as the owner. j/k go to the next
// and previous issue in the project, Esc goes back.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {open, last} = useIssueLink()
const {who, load} = useOwner()
const {of: schedulesOf, edit: editSchedule} = useSchedules()
/** The schedule that made it, if one did (and still exists). */
const madeBy = computed(() => issue.value?.schedule && project.value ? schedulesOf(project.value.id).find(s => s.id === issue.value!.schedule) : undefined)

const project = computed(() => byId(route.params.project as string))
const issueId = computed(() => route.params.issue as string)
const found = computed(() => findIssue(project.value, issueId.value))
// An id it had before (MOT-5) goes to its own address.
watch(found, f => {
    if (f && f.issue.id !== issueId.value) router.replace(`/p/${route.params.project}/issues/${encodeURIComponent(f.issue.id)}`)
}, {immediate: true})
const issue = computed(() => found.value?.issue)
const order = computed(() => project.value ? allIssues(project.value).map(i => i.issue.id) : [])
const at = computed(() => order.value.indexOf(issueId.value))

watch(() => [project.value?.id, issueId.value] as const, ([p, i]) => {
    if (p && i) last.value = `${p}/${i}`
}, {immediate: true})

const comments = ref<Comment[]>([])
watch(() => [project.value?.id, issueId.value, issue.value?.updatedAt] as const, async ([p, i]) => {
    if (!p || !i || !issue.value) return
    comments.value = await $fetch<Comment[]>(`/api/projects/${encodeURIComponent(p)}/issues/${encodeURIComponent(i)}/comments`).catch(() => [])
}, {immediate: true})

/** Back to the board or list it was opened from, else the project. */
function back() {
    const from = (history.state as {back?: string} | null)?.back
    if (from && from.startsWith(`/p/${route.params.project}`) && !from.includes('/issues/')) router.back()
    else router.push(`/p/${route.params.project}`)
}

// Removing it (and its sub-issues), as the owner: asked once more in place, then back to where it was opened from.
const removing = ref<'ask' | 'busy' | null>(null)
const removeFailed = ref('')
watch(issueId, () => {
    removing.value = null
    removeFailed.value = ''
})
async function remove() {
    if (!project.value || !issue.value) return
    removing.value = 'busy'
    removeFailed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(project.value.id)}/issues/${encodeURIComponent(issue.value.id)}`, {method: 'DELETE', headers: {'Orrery-Actor': await load()}})
        back()
    } catch (error) {
        removing.value = 'ask'
        removeFailed.value = (error as {data?: {message?: string}}).data?.message ?? "Couldn't remove it. Is Orrery running?"
    }
}
// The title, edited in place: Enter saves, Esc puts it back.
const {save, saving, failed: saveFailed} = useIssueSave(() => project.value?.id ?? '', issueId)
const editingTitle = ref(false)
const title = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
function editTitle() {
    if (!issue.value) return
    title.value = issue.value.title
    editingTitle.value = true
    nextTick(() => titleInput.value?.select())
}
async function saveTitle() {
    if (!editingTitle.value) return
    const next = title.value.trim()
    if (next && next !== issue.value?.title && !await save({title: next})) return
    editingTitle.value = false
}

// The description, as Markdown: ⌘↵ saves, Esc leaves it as it was.
const editingNotes = ref(false)
const notes = ref('')
const notesInput = ref<HTMLTextAreaElement | null>(null)
function editNotes() {
    notes.value = issue.value?.notes ?? ''
    editingNotes.value = true
    nextTick(() => notesInput.value?.focus())
}
async function saveNotes() {
    const next = notes.value.trim()
    if (next !== (issue.value?.notes ?? '') && !await save({notes: next || null})) return
    editingNotes.value = false
}
watch(issueId, () => {
    editingTitle.value = editingNotes.value = false
})

const under = (tasks: Issue[]): number => tasks.reduce((n, t) => n + 1 + under(t.tasks), 0)
const subCount = computed(() => issue.value ? under(issue.value.tasks) : 0)

function step(by: number) {
    const next = order.value[at.value + by]
    if (next && project.value) router.replace(`/p/${project.value.id}/issues/${encodeURIComponent(next)}`)
}

function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (event.metaKey || event.ctrlKey || event.altKey || useState('palette-open').value) return
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
    if (event.key === 'j') step(1)
    else if (event.key === 'k') step(-1)
    else if (event.key === 'Escape') back()
    else return
    event.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

useHead(() => ({title: issue.value ? `${issue.value.id} ${issue.value.title} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <button type="button" class="-ml-1 hidden rounded-md p-1 text-faint hover:bg-hover hover:text-fg md:block" title="Back (Esc)" aria-label="Back" @click="back">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </button>
      <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
        <NuxtLink :to="`/p/${project.id}`" class="shrink-0 font-medium hover:text-fg">{{ project.name }}</NuxtLink>
        <template v-if="found">
          <span class="text-faint">/</span>
          <NuxtLink :to="chunkPath(project.id, found.chunk.id)" class="hidden max-w-48 truncate text-muted hover:text-fg sm:inline">{{ found.chunk.title }}</NuxtLink>
          <template v-for="parent in found.parents" :key="parent.id">
            <span class="hidden text-faint sm:inline">/</span>
            <button type="button" class="hidden font-mono text-xs text-muted hover:text-fg sm:inline" @click="open(project.id, parent.id)">{{ parent.id }}</button>
          </template>
          <span class="hidden text-faint sm:inline">/</span>
          <span class="truncate font-mono text-xs text-fg">{{ issueId }}</span>
        </template>
      </nav>
    </template>
    <template v-if="project && at >= 0" #actions>
      <div class="ml-auto flex items-center gap-1 text-xs text-faint">
        <span class="mr-1 font-mono tabular-nums">{{ at + 1 }} / {{ order.length }}</span>
        <button type="button" class="rounded-md p-1 hover:bg-hover hover:text-fg disabled:opacity-30" :disabled="at <= 0" title="Previous (k)" aria-label="Previous issue" @click="step(-1)">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6" /></svg>
        </button>
        <button type="button" class="rounded-md p-1 hover:bg-hover hover:text-fg disabled:opacity-30" :disabled="at >= order.length - 1" title="Next (j)" aria-label="Next issue" @click="step(1)">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="issue && found && project" :key="issue.id" class="mx-auto flex max-w-6xl animate-fade-up flex-col lg:flex-row">
      <article class="flex min-w-0 flex-1 flex-col gap-8 px-4 py-6 sm:px-8 sm:py-10">
        <header class="flex flex-col gap-2">
          <div class="flex items-center gap-1.5">
            <span class="font-mono text-xs text-faint">{{ issue.id }}</span>
            <CopyButton :text="issue.id" />
            <button
                v-if="madeBy"
                type="button"
                class="flex h-6 items-center gap-1 rounded-full px-2 text-[11px] text-muted ring-1 ring-line hover:bg-hover hover:text-fg"
                :title="`Made by the schedule “${madeBy.title}” (${describe(madeBy)}); click to edit it`"
                @click="editSchedule(madeBy.project, madeBy)"
            >
              <SectionIcon section="schedules" class="size-3" /> {{ madeBy.title }}
            </button>
            <button
                v-if="!removing"
                type="button"
                class="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                title="Remove this issue"
                @click="removing = 'ask'"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
              Remove
            </button>
            <span v-else class="ml-auto flex items-center gap-2 text-xs" @keydown.esc.stop="removing = null">
              <span class="text-muted">Remove {{ issue.id }}{{ subCount ? ` and its ${subCount} sub-issue${subCount === 1 ? '' : 's'}` : '' }}, with its comments?</span>
              <button type="button" class="h-7 rounded-md bg-rose-600 px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="removing === 'busy'" @click="remove">
                {{ removing === 'busy' ? 'Removing…' : 'Remove' }}
              </button>
              <button type="button" class="h-7 rounded-md px-2 text-muted ring-1 ring-line hover:bg-hover hover:text-fg" :disabled="removing === 'busy'" @click="removing = null">Cancel</button>
            </span>
          </div>
          <p v-if="removeFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ removeFailed }}</p>
          <input
              v-if="editingTitle"
              ref="titleInput"
              v-model="title"
              aria-label="Title"
              class="-mx-2 rounded-lg bg-well px-2 py-0.5 text-xl leading-snug font-semibold tracking-tight text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none sm:text-2xl"
              :disabled="saving"
              @keydown.enter.prevent="saveTitle"
              @keydown.esc.stop.prevent="editingTitle = false"
              @blur="saveTitle"
          >
          <h1
              v-else
              class="-mx-2 cursor-text rounded-lg px-2 py-0.5 text-xl leading-snug font-semibold tracking-tight text-fg hover:bg-hover sm:text-2xl"
              title="Click to edit"
              @click="editTitle"
          ><InlineText :text="issue.title" /></h1>
          <p v-if="saveFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ saveFailed }}</p>
        </header>

        <div class="lg:hidden">
          <IssueProperties :issue="issue" :project="project" :chunk="found.chunk" :sub="found.parents.length > 0" />
        </div>

        <ProposalPanel :project="project.id" :issue="issue" />

        <SessionsPanel v-if="issue.column !== 'done'" :project="project.id" :issue="issue.id" />

        <section v-if="editingNotes" class="flex flex-col gap-2" @keydown.esc.stop.prevent="editingNotes = false">
          <textarea
              ref="notesInput"
              v-model="notes"
              aria-label="Description"
              placeholder="Describe it, in Markdown"
              rows="10"
              class="field-sizing-content min-h-40 w-full resize-y rounded-xl bg-well px-4 py-3 font-mono text-[13px] leading-6 text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              :disabled="saving"
              @keydown.meta.enter.prevent="saveNotes"
              @keydown.ctrl.enter.prevent="saveNotes"
          />
          <div class="flex items-center justify-end gap-2">
            <span class="mr-auto text-xs text-faint">Markdown</span>
            <button type="button" class="h-7 rounded-md px-2.5 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg" :disabled="saving" @click="editingNotes = false">Cancel <KeyHint>esc</KeyHint></button>
            <button type="button" class="flex h-7 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="saving" @click="saveNotes">
              {{ saving ? 'Saving…' : 'Save' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
            </button>
          </div>
        </section>
        <section v-else class="group relative">
          <button
              type="button"
              class="absolute -top-1 right-0 flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted opacity-0 ring-1 ring-line transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus:opacity-100"
              @click="editNotes"
          >Edit</button>
          <MarkdownView v-if="issue.notes" :source="issue.notes" />
          <button v-else type="button" class="text-sm text-faint italic hover:text-muted" @click="editNotes">No description. Add one</button>
        </section>

        <section v-if="issue.tasks.length" class="flex flex-col gap-2">
          <h2 class="label flex items-center gap-2">Sub-issues <span class="font-mono normal-case">{{ issue.counts.done }}/{{ total(issue.counts) }}</span></h2>
          <div class="overflow-hidden rounded-xl border border-line">
            <IssueRow v-for="sub in issue.tasks" :key="sub.id" :issue="sub" :project="project.id" nested class="last:border-b-0" />
          </div>
        </section>

        <section class="flex flex-col gap-3">
          <h2 class="label">Activity</h2>
          <ol class="relative flex flex-col gap-5 border-l border-line pl-5">
            <li class="text-xs text-faint">
              <span class="absolute -left-[3px] mt-1.5 size-1.5 rounded-full bg-faint/60" />
              <span class="text-muted">{{ who(issue.createdBy) }}</span> created the issue · <span :title="issue.createdAt">{{ ago(issue.createdAt) }}</span>
            </li>
            <li v-for="comment in comments" :key="comment.id" class="flex flex-col gap-1.5">
              <div class="-ml-[31px] flex items-center gap-2 text-xs">
                <PersonAvatar :name="comment.createdBy" :size="20" />
                <span class="font-medium text-fg">{{ who(comment.createdBy) }}</span>
                <span class="text-faint" :title="comment.createdAt">{{ ago(comment.createdAt) }}{{ comment.updatedAt !== comment.createdAt ? ' · edited' : '' }}</span>
                <span
                    v-if="comment.asks"
                    class="rounded-full px-1.5 py-px text-[10px] font-medium ring-1"
                    :class="comment.answered ? 'text-faint ring-line' : 'bg-accent-500/10 text-accent-700 ring-accent-500/30 dark:text-accent-300'"
                >{{ comment.answered ? `${comment.asks === 'decision' ? 'Decision' : 'Feedback'} answered` : comment.asks === 'decision' ? 'Needs your decision' : 'Needs your feedback' }}</span>
              </div>
              <div class="rounded-xl bg-well px-4 py-3 ring-1 ring-line"><MarkdownView :source="comment.body" class="text-[13px] leading-6" /></div>
            </li>
          </ol>
          <CommentBox :project="project.id" :issue="issue.id" @posted="c => comments = [...comments.filter(x => x.id !== c.id), c]" />
        </section>

        <p class="rounded-lg bg-well px-3 py-2 font-mono text-[11px] text-faint ring-1 ring-line">PATCH /api/projects/{{ project.id }}/issues/{{ issue.id }}</p>
      </article>

      <aside class="hidden w-80 shrink-0 border-l border-line px-6 py-10 lg:block">
        <div class="sticky top-6">
          <IssueProperties :issue="issue" :project="project" :chunk="found.chunk" :sub="found.parents.length > 0" />
        </div>
      </aside>
    </div>

    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
      <div class="flex flex-col items-center gap-2">
        <p>No issue <span class="font-mono">{{ issueId }}</span>{{ project ? ` in ${project.name}` : '' }}.</p>
        <p class="text-xs text-faint">It may have moved or been deleted.</p>
        <NuxtLink :to="project ? `/p/${project.id}` : '/now'" class="mt-2 text-xs text-fg underline">Back</NuxtLink>
      </div>
    </div>
  </div>
</template>
