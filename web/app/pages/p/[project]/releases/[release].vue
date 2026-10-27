<script setup lang="ts">
import type {Kinds} from '#shared/roadmap'
import {emptyKinds, isFrozen} from '#shared/roadmap'
import {CheckIcon, SunIcon} from '@heroicons/vue/16/solid'

// A release's page: whether it shipped (and when), the branch its work gathers on with its PRs (when the
// project says where its code is), its notes, a changelog drafted from its issues, and every one of those
// issues by status (the board's filters would hide the done ones, most of a release), each row saying its chunk. The branch, notes and day edit in place, as the owner, and it can be
// removed (its issues stay, set for none). A release shared across projects is its source's: there it shows each
// project's issues in a section of their own, and from a project drawing on it, that project's, linking the whole.
// Esc goes back to the releases.
const route = useRoute()
const router = useRouter()
const {projects, byId, ready} = useRoadmaps()
const {load} = useOwner()

const project = computed(() => byId(route.params.project as string))
// The project the release is made in: this one, or the one it takes its releases from.
const source = computed(() => project.value?.releases_from ? byId(project.value.releases_from) : project.value)
const version = computed(() => String(route.params.release))
const release = computed(() => project.value?.releases.find(r => r.version === version.value))
// All of it, across the projects drawing on it.
const whole = computed(() => source.value?.releases.find(r => r.version === version.value) ?? release.value)
// Each project's part: on its source, the source's and then each drawing on it with issues in it; else this project's.
const parts = computed(() => {
    if (!project.value || !release.value) return []
    const {id} = project.value
    const shown = project.value.releases_from ? [project.value] : [project.value, ...projects.value.filter(p => p.releases_from === id)]
    return shown.map(p => {
        const chunks = releaseChunks(p, version.value)
        const tasks = chunks.flatMap(c => c.tasks)
        const kinds = emptyKinds()
        tasks.forEach(issue => (Object.keys(kinds) as (keyof Kinds)[]).forEach(kind => kinds[kind] += issue.kinds[kind]))
        return {project: p, chunks, issues: tasks.length, kinds}
    // A project drawing on it with nothing in it gets no section.
    }).filter((part, i) => i === 0 || part.issues)
})
const chunks = computed(() => parts.value[0]?.chunks ?? [])
const changelog = computed(() => release.value ? changelogOf(release.value, parts.value.flatMap(p => p.chunks)) : '')

// Where the branch and its PRs are, on GitHub or a forge that answers the same addresses.
const links = computed(() => {
    const repo = source.value?.repo
    const branch = release.value?.branch
    if (!repo || !branch) return null
    return {branch: `${repo}/tree/${encodeURIComponent(branch)}`, prs: `${repo}/pulls?q=${encodeURIComponent(`is:pr base:${branch}`)}`}
})

const saving = ref(false)
const failed = ref('')
const api = computed(() => source.value ? `/api/projects/${encodeURIComponent(source.value.id)}/releases/${encodeURIComponent(version.value)}` : '')
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
const ship = () => save({shipped_on: today()})
const unship = () => save({shipped_on: null})
// A freeze is a preference, not a lock: the release keeps taking whatever is set for it.
const freeze = () => save({frozen_on: today()})
const thaw = () => save({frozen_on: null})

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
      <UiButton :to="`/p/${project.id}/releases`" variant="ghost" size="xs" square class="-ml-1 max-md:hidden" title="Back to the releases (Esc)" aria-label="Back">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </UiButton>
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
              :class="release.shipped_on ? 'text-emerald-700 ring-emerald-500/30 dark:text-emerald-300' : isFrozen(release) ? 'text-amber-700 ring-amber-500/30 dark:text-amber-300' : 'text-accent-600 ring-accent-500/30 dark:text-accent-300'"
              :title="isFrozen(release) ? 'Feature freeze: fixes, tests and docs; a new feature goes on the next release' : undefined"
          >{{ release.shipped_on ? `Shipped ${release.shipped_on}` : isFrozen(release) ? `Frozen ${release.frozen_on}` : 'Preparing' }}</span>
          <template v-if="!release.shipped_on">
            <UiButton v-if="!release.frozen_on" variant="warning-outline" :disabled="saving" title="From now on it takes fixes, tests and docs; a new feature goes on the next release" @click="freeze">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2M4 10.5l2.6-1.5-.1-3.5M20 13.5 17.4 15l.1 3.5M4 13.5 6.6 15l-.1 3.5M20 10.5 17.4 9l.1-3.5" /></svg>
              Freeze features
            </UiButton>
            <UiButton v-else :disabled="saving" title="Back to preparing: it takes new features again" @click="thaw">
              <SunIcon class="size-3.5" />
              Thaw features
            </UiButton>
          </template>
          <UiButton v-if="!release.shipped_on" variant="success-outline" :disabled="saving" @click="ship">
            <CheckIcon class="size-3.5" />
            Mark shipped today
          </UiButton>
          <UiButton v-else :disabled="saving" @click="unship">Not shipped yet</UiButton>
          <span class="ml-auto flex items-center gap-2">
            <UiConfirm v-if="confirmingRemove" inline :busy="saving" @confirm="remove" @cancel="confirmingRemove = false">
              Remove {{ release.version }}? Its {{ whole!.issues }} {{ whole!.issues === 1 ? 'issue stays' : 'issues stay' }}, set for no release.
            </UiConfirm>
            <UiButton
                v-else
                variant="danger-ghost"
                size="xs"
                square
                title="Remove this release"
                aria-label="Remove this release"
                @click="confirmingRemove = true"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            </UiButton>
          </span>
        </div>
        <h1 class="font-mono text-xl font-semibold tracking-tight text-fg sm:text-2xl">{{ release.version }}</h1>
        <p v-if="project.releases_from" class="text-xs text-muted">
          Shared: {{ source?.name ?? project.releases_from }}'s release, with {{ project.name }}'s issues here.
          <NuxtLink :to="releasePath(project.releases_from, release.version)" class="text-fg underline underline-offset-2">The whole release</NuxtLink>
        </p>

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
          <NuxtLink v-else-if="release.branch && source && !source.repo" :to="`/p/${source.id}/settings#repo`" class="text-faint underline underline-offset-2 hover:text-fg">Say where the code is, to link its PRs</NuxtLink>
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
            <UiButton :disabled="saving" @click="editingNotes = false">Cancel <KeyHint>esc</KeyHint></UiButton>
            <UiButton variant="primary" :disabled="saving" @click="saveNotes">
              {{ saving ? 'Saving…' : 'Save' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
            </UiButton>
          </div>
        </section>
        <section v-else class="group relative">
          <UiButton
              v-if="release.notes"
              class="absolute -top-1 right-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              @click="editNotes"
          >Edit</UiButton>
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
      <template v-if="parts.length > 1">
        <section v-for="part in parts" :key="part.project.id">
          <ViewToolbar>
            <NuxtLink :to="`/p/${part.project.id}`" class="label hover:text-fg">{{ part.project.name }}</NuxtLink>
            <ProgressRing :kinds="part.kinds" :size="14" />
            <span class="text-xs text-faint">{{ part.issues }} {{ part.issues === 1 ? 'issue' : 'issues' }}</span>
          </ViewToolbar>
          <ListView v-if="part.chunks.length" :chunks="part.chunks" :project="part.project.id" group="status" />
          <p v-else class="px-4 py-6 text-center text-xs text-faint">None of {{ part.project.name }}'s issues are set for it yet.</p>
        </section>
      </template>
      <template v-else>
        <ViewToolbar>
          <span class="label">Issues</span>
        </ViewToolbar>
        <ListView v-if="chunks.length" :chunks="chunks" :project="project.id" group="status" />
        <p v-else class="px-4 py-16 text-center text-sm text-muted">No issues set for this release yet. Pick it under Release on an issue’s page.</p>
      </template>
    </template>
    <NotFound v-else-if="ready" :to="`/p/${route.params.project}/releases`" back="Back to the releases">No release “{{ route.params.release }}”</NotFound>
  </div>
</template>
