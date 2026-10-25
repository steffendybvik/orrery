<script setup lang="ts">
// A release's page: whether it shipped (and when), the branch its work gathers on with its PRs (when the
// project says where its code is), its notes, a changelog drafted from its issues, and every one of those
// issues by status (the board's filters would hide the done ones, most of a release), each row saying its chunk. The branch, notes and day edit in place, as the owner, and it can be
// removed (its issues stay, set for none). Esc goes back to the releases.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {load} = useOwner()

const project = computed(() => byId(route.params.project as string))
const version = computed(() => String(route.params.release))
const release = computed(() => project.value?.releases.find(r => r.version === version.value))
const chunks = computed(() => project.value && release.value ? releaseChunks(project.value, release.value.version) : [])
const changelog = computed(() => release.value ? changelogOf(release.value, chunks.value) : '')

// Where the branch and its PRs are, on GitHub or a forge that answers the same addresses.
const links = computed(() => {
    const repo = project.value?.repo
    const branch = release.value?.branch
    if (!repo || !branch) return null
    return {branch: `${repo}/tree/${encodeURIComponent(branch)}`, prs: `${repo}/pulls?q=${encodeURIComponent(`is:pr base:${branch}`)}`}
})

const saving = ref(false)
const failed = ref('')
const api = computed(() => project.value ? `/api/projects/${encodeURIComponent(project.value.id)}/releases/${encodeURIComponent(version.value)}` : '')
async function save(body: Record<string, unknown>): Promise<boolean> {
    saving.value = true
    failed.value = ''
    try {
        await $fetch(api.value, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body})
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        return false
    } finally {
        saving.value = false
    }
}

const today = () => new Date().toLocaleDateString('sv')
const ship = () => save({shippedOn: today()})
const unship = () => save({shippedOn: null})

// The branch, edited in place: Enter saves, Esc puts it back.
const editingBranch = ref(false)
const branch = ref('')
const branchInput = ref<HTMLInputElement | null>(null)
function editBranch() {
    branch.value = release.value?.branch ?? ''
    editingBranch.value = true
    nextTick(() => branchInput.value?.select())
}
async function saveBranch() {
    if (!editingBranch.value) return
    const next = branch.value.trim()
    if (next !== (release.value?.branch ?? '') && !await save({branch: next || null})) return
    editingBranch.value = false
}

// The notes, in Markdown: ⌘↵ saves, Esc leaves them as they were.
const editingNotes = ref(false)
const notes = ref('')
const notesInput = ref<HTMLTextAreaElement | null>(null)
function editNotes() {
    notes.value = release.value?.notes ?? ''
    editingNotes.value = true
    nextTick(() => notesInput.value?.focus())
}
async function saveNotes() {
    const next = notes.value.trim()
    if (next !== (release.value?.notes ?? '') && !await save({notes: next || null})) return
    editingNotes.value = false
}
watch(version, () => editingBranch.value = editingNotes.value = false)

const confirmingRemove = ref(false)
async function remove() {
    if (!project.value) return
    saving.value = true
    failed.value = ''
    try {
        await $fetch(api.value, {method: 'DELETE', headers: {'Orrery-Actor': await load()}})
        router.push(`/p/${project.value.id}/releases`)
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
    router.push(`/p/${route.params.project}/releases`)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

useHead(() => ({title: release.value && project.value ? `${release.value.version} · ${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <NuxtLink :to="`/p/${project.id}/releases`" class="-ml-1 hidden rounded-md p-1 text-faint hover:bg-hover hover:text-fg md:block" title="Back to the releases (Esc)" aria-label="Back">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </NuxtLink>
      <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
        <NuxtLink :to="`/p/${project.id}`" class="shrink-0 font-medium hover:text-fg">{{ project.name }}</NuxtLink>
        <span class="text-faint">/</span>
        <NuxtLink :to="`/p/${project.id}/releases`" class="shrink-0 text-muted hover:text-fg">Releases</NuxtLink>
        <template v-if="release">
          <span class="text-faint">/</span>
          <span class="truncate font-mono text-fg">{{ release.version }}</span>
        </template>
      </nav>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <template v-if="project && release">
      <header class="mx-auto flex max-w-5xl animate-fade-up flex-col gap-4 px-4 pt-8 pb-6 sm:px-8">
        <div class="flex flex-wrap items-center gap-3 text-xs">
          <span
              class="rounded-full px-2 py-px text-[11px] font-medium ring-1"
              :class="release.shippedOn ? 'text-emerald-700 ring-emerald-500/30 dark:text-emerald-300' : 'text-accent-600 ring-accent-500/30 dark:text-accent-300'"
          >{{ release.shippedOn ? `Shipped ${release.shippedOn}` : 'Preparing' }}</span>
          <button v-if="!release.shippedOn" type="button" class="h-7 rounded-md px-2.5 text-muted ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50" :disabled="saving" @click="ship">Mark shipped today</button>
          <button v-else type="button" class="h-7 rounded-md px-2.5 text-muted ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50" :disabled="saving" @click="unship">Not shipped yet</button>
          <span class="ml-auto flex items-center gap-2">
            <template v-if="confirmingRemove">
              <span class="text-muted">Remove {{ release.version }}? Its {{ release.issues }} {{ release.issues === 1 ? 'issue stays' : 'issues stay' }}, set for no release.</span>
              <button type="button" class="h-7 rounded-md bg-rose-600 px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="saving" @click="remove">{{ saving ? 'Removing…' : 'Remove' }}</button>
              <button type="button" class="h-7 rounded-md px-2 text-muted ring-1 ring-line hover:bg-hover hover:text-fg" :disabled="saving" @click="confirmingRemove = false">Cancel</button>
            </template>
            <button
                v-else
                type="button"
                class="rounded-md p-1 text-faint hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                title="Remove this release"
                aria-label="Remove this release"
                @click="confirmingRemove = true"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            </button>
          </span>
        </div>
        <h1 class="font-mono text-xl font-semibold tracking-tight text-fg sm:text-2xl">{{ release.version }}</h1>

        <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span class="label">Branch</span>
          <input
              v-if="editingBranch"
              ref="branchInput"
              v-model="branch"
              aria-label="Branch"
              spellcheck="false"
              placeholder="v1.0.0-rc.2"
              class="h-7 w-56 rounded-md bg-well px-2 font-mono text-xs text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              :disabled="saving"
              @keydown.enter.prevent="saveBranch"
              @keydown.esc.stop.prevent="editingBranch = false"
              @blur="saveBranch"
          >
          <button v-else type="button" class="rounded-md px-1.5 py-0.5 font-mono hover:bg-hover hover:text-fg" :class="!release.branch && 'font-sans text-faint italic'" title="Click to edit" @click="editBranch">{{ release.branch ?? 'None. Add one' }}</button>
          <template v-if="links && !editingBranch">
            <a :href="links.branch" target="_blank" rel="noopener" class="text-accent-600 underline decoration-accent-500/40 underline-offset-2 hover:decoration-accent-500 dark:text-accent-400">Code</a>
            <a :href="links.prs" target="_blank" rel="noopener" class="text-accent-600 underline decoration-accent-500/40 underline-offset-2 hover:decoration-accent-500 dark:text-accent-400">PRs into it</a>
          </template>
          <NuxtLink v-else-if="release.branch && !project.repo" :to="`/p/${project.id}/settings#repo`" class="text-faint underline underline-offset-2 hover:text-fg">Say where the code is, to link its PRs</NuxtLink>
        </div>

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
            <button type="button" class="h-7 rounded-md px-2.5 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg" :disabled="saving" @click="editingNotes = false">Cancel <KeyHint>esc</KeyHint></button>
            <button type="button" class="flex h-7 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="saving" @click="saveNotes">
              {{ saving ? 'Saving…' : 'Save' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
            </button>
          </div>
        </section>
        <section v-else class="group relative">
          <button
              v-if="release.notes"
              type="button"
              class="absolute -top-1 right-0 flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted opacity-0 ring-1 ring-line transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus:opacity-100"
              @click="editNotes"
          >Edit</button>
          <MarkdownView v-if="release.notes" :source="release.notes" />
          <button v-else type="button" class="text-sm text-faint italic hover:text-muted" @click="editNotes">No notes. Add some</button>
        </section>
        <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>

        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-faint">
          <ProgressRing :kinds="release.kinds" :size="16" />
          <span>{{ release.issues }} {{ release.issues === 1 ? 'issue' : 'issues' }}<template v-if="progress(release.kinds).total !== release.issues"> · {{ progress(release.kinds).total }} with sub-issues</template></span>
        </div>

        <details v-if="release.issues" class="group rounded-xl border border-line">
          <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-medium text-fg">
            <svg class="size-3 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            Changelog draft
            <span class="text-xs font-normal text-faint max-sm:hidden">from its issues' titles, to edit into CHANGELOG.md</span>
          </summary>
          <div class="px-4 pb-4">
            <CopyBlock title="Markdown" :text="changelog" hint="Done issues first; open ones follow in a comment, so nothing slips." />
          </div>
        </details>
      </header>
      <ViewToolbar>
        <span class="label">Issues</span>
      </ViewToolbar>
      <ListView v-if="chunks.length" :chunks="chunks" :project="project.id" group="status" />
      <p v-else class="px-4 py-16 text-center text-sm text-muted">No issues set for this release yet. Pick it under Release on an issue’s page.</p>
    </template>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">
      No release “{{ route.params.release }}”. <NuxtLink :to="`/p/${route.params.project}/releases`" class="ml-1 text-fg underline">Back to the releases</NuxtLink>
    </div>
  </div>
</template>
