<script setup lang="ts">
// A project's settings: its name, where its code is, whether it has releases and whose, its icon in the sidebar and the icon's colour, and deleting
// the project, for good. Its schedules and sessions are on the Schedules and Sessions pages, kept to it.
const route = useRoute()
const router = useRouter()
const {projects, byId, ready} = useRoadmaps()
const {shared} = usePeople()
const {of} = useSchedules()
const project = computed(() => byId(route.params.project as string))

// Its name, saved on Enter or on leaving the field; Esc puts it back.
const name = ref('')
const nameFailed = ref('')
watch(() => project.value?.name, now => {
    name.value = now ?? ''
}, {immediate: true})
async function rename() {
    if (!project.value) return
    const next = name.value.trim()
    if (!next || next === project.value.name) {
        name.value = project.value.name
        return
    }
    nameFailed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body: {name: next}})
    } catch (error) {
        nameFailed.value = errorMessage(error)
    }
}

// Where its code is, so a release links its branch and PRs and an issue shows its open ones; saved like the name.
const repo = ref('')
const repoFailed = ref('')
watch(() => project.value?.repo, now => {
    repo.value = now ?? ''
}, {immediate: true})
async function saveRepo() {
    if (!project.value) return
    const next = repo.value.trim().replace(/\/+$/, '')
    if (next === (project.value.repo ?? '')) return
    repoFailed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body: {repo: next || null}})
    } catch (error) {
        repoFailed.value = errorMessage(error)
    }
}

// Whether it has releases: none (not every project ships), its own, or another project's (a monorepo's apps going
// out together). A project can draw on one that has its own; it leaves its own only while nothing draws on them and
// none are left, and the server says why not.
const drawing = computed(() => projects.value.filter(p => p.releases_from === project.value?.id))
const sources = computed(() => projects.value.filter(p => p.id !== project.value?.id && p.release_mode === 'own'))
// The choice as the select holds it: `none`, `own`, or `from:<project>`.
const releaseChoice = computed(() => project.value?.release_mode === 'shared' ? `from:${project.value.releases_from}` : project.value?.release_mode ?? 'none')
const releaseOptions = computed(() => [
    {value: 'none', label: 'None'},
    {value: 'own', label: 'Its own'},
    ...sources.value.map(source => ({value: `from:${source.id}`, label: `${source.name}'s`})),
])
const releasesFailed = ref('')
async function saveReleaseMode(next: string) {
    if (!project.value) return
    const body = next.startsWith('from:') ? {release_mode: 'shared', releases_from: next.slice(5)} : {release_mode: next}
    releasesFailed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body})
    } catch (error) {
        releasesFailed.value = errorMessage(error)
    }
}

// Its icon: any Heroicon, found by name, in a colour (or the text's). The sidebar shows it in place of
// the progress ring.
const iconFailed = ref('')
async function saveIcon(change: {icon?: string | null, icon_color?: string | null}) {
    if (!project.value) return
    iconFailed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body: change})
    } catch (error) {
        iconFailed.value = errorMessage(error)
    }
}

// Deleting it, for good: what goes is spelled out, and the project's id has to be typed to confirm.
const deleting = ref(false)
const typed = ref('')
const removing = ref(false)
const failed = ref('')
const loses = computed(() => {
    if (!project.value) return []
    const issues = allIssues(project.value).length
    const chunks = project.value.board.chunks.filter(c => c.id).length
    const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
    return [n(issues, 'issue'), n(chunks, 'chunk'), n(project.value.docs.length, 'doc'), n(of(project.value.id).length, 'schedule'), 'every comment and signal']
})
watch(() => route.params.project, () => {
    deleting.value = false
    typed.value = ''
})
async function remove() {
    if (!project.value || typed.value !== project.value.id) return
    removing.value = true
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(project.value.id)}`, {method: 'DELETE'})
        router.push('/mine')
    } catch (error) {
        failed.value = errorMessage(error, 'delete')
    } finally {
        removing.value = false
    }
}
useHead(() => ({title: project.value ? `Settings · ${project.value.name} · orrery` : 'orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
    </template>
    <h1 v-else-if="ready" class="truncate text-sm font-medium">Not found</h1>
  </PageHeader>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <div v-if="project" class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-8 px-4 py-8 sm:px-8">
      <section id="name" class="flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Name</h2>
          <p class="text-xs text-muted">How it's shown everywhere. Its id (<span class="font-mono">{{ project.id }}</span>) and issue ids (<span class="font-mono">{{ project.key }}-n</span>) stay as they are, so links and agents keep working.</p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="rename">
          <input
              v-model="name"
              aria-label="Project name"
              spellcheck="false"
              class="h-8 w-72 max-w-full field"
              @blur="rename"
              @keydown.esc="name = project.name; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="nameFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ nameFailed }}</span>
        </form>
      </section>

      <section id="repo" class="flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Code</h2>
          <p class="text-xs text-muted">Where {{ project.name }}'s code is, so a release links its branch and the PRs into it, and an issue's page shows its open PRs (on GitHub).</p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveRepo">
          <input
              v-model="repo"
              type="url"
              aria-label="Where its code is"
              placeholder="https://github.com/you/shop"
              spellcheck="false"
              class="h-8 w-96 max-w-full field"
              @blur="saveRepo"
              @keydown.esc="repo = project.repo ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="repoFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ repoFailed }}</span>
        </form>
      </section>

      <section id="releases" class="flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Releases</h2>
          <p class="text-xs text-muted">
            Whether {{ project.name }} ships in releases. Give it its own when it ships versions, or take another project's when several go out
            together, as a monorepo's apps do: its issues are set for that project's releases, and each release counts them.
            Without releases, it has no Releases page.
          </p>
        </header>
        <div class="flex flex-wrap items-center gap-2">
          <PropertyPicker
              :model-value="releaseChoice"
              :options="releaseOptions"
              label="Its releases"
              placeholder="Find a project…"
              field
              :disabled="!!drawing.length"
              @update:model-value="saveReleaseMode($event as string)"
          >
            <span class="truncate">{{ releaseOptions.find(o => o.value === releaseChoice)?.label ?? releaseChoice }}</span>
          </PropertyPicker>
          <span v-if="drawing.length" class="text-xs text-faint">{{ drawing.map(p => p.name).join(', ') }} {{ drawing.length === 1 ? 'takes its' : 'take their' }} releases from {{ project.name }}.</span>
          <span v-if="releasesFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ releasesFailed }}</span>
        </div>
      </section>

      <section id="icon" class="flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex items-start gap-3">
          <div class="mt-0.5 grid size-4 place-items-center text-accent-fill">
            <ProjectIcon v-if="project.icon" :icon="project.icon" :color="project.icon_color" class="size-4" />
            <ProgressRing v-else :kinds="project.board.kinds" bare :size="14" />
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 class="text-[15px] font-semibold text-fg">Icon</h2>
            <p class="text-xs text-muted">Shows by {{ project.name }} in the sidebar, in place of its progress ring, so you can spot it among the rest. Any of the <a href="https://heroicons.com" target="_blank" rel="noopener" class="underline underline-offset-2 hover:text-fg">Heroicons</a>.</p>
          </div>
          <UiButton v-if="project.icon" class="shrink-0" @click="saveIcon({icon: null})">Use the ring</UiButton>
        </header>
        <IconPicker :icon="project.icon ?? null" :color="project.icon_color ?? null" @change="change => saveIcon({icon: change.icon, icon_color: change.color})">
          <p v-if="iconFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ iconFailed }}</p>
        </IconPicker>
      </section>

      <BoardMembers v-if="shared" :project="project.id" />

      <section id="export" class="flex flex-col gap-3 border-t border-line pt-8">
        <div>
          <h2 class="text-[15px] font-semibold text-fg">Export</h2>
          <p class="mt-0.5 text-[13px] text-muted">The whole board as one file: its issues, comments, activity, docs and their history, images, schedules and presets. Secrets stay here, and the board stays as it is.</p>
        </div>
        <div>
          <a :href="apiUrl(`/projects/${encodeURIComponent(project.id)}/export`)" download class="inline-flex items-center rounded-md px-3 py-1.5 text-[13px] font-medium ring-1 ring-line text-fg hover:bg-hover">Download the board</a>
        </div>
      </section>

      <section id="upload" class="flex flex-col gap-3 border-t border-line pt-8">
        <div>
          <h2 class="text-[15px] font-semibold text-fg">Upload</h2>
          <p class="mt-0.5 text-[13px] text-muted">Brings a board's file in as a new board, so this one stays as it is. Nothing in the file counts as yours, and its schedules arrive paused.</p>
        </div>
        <BoardUpload />
      </section>

      <section id="danger" class="mt-4 flex flex-col gap-3 rounded-xl border border-rose-500/30 p-4">
        <header class="flex items-start gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 class="text-[15px] font-semibold text-rose-700 dark:text-rose-400">Delete this project</h2>
            <p class="text-xs text-muted">Removes {{ project.name }} and everything in it from orrery.</p>
          </div>
          <UiButton v-if="!deleting" variant="danger-outline" class="shrink-0" @click="deleting = true">Delete project…</UiButton>
        </header>
        <form v-if="deleting" class="flex flex-col gap-3" @submit.prevent="remove" @keydown.esc="deleting = false">
          <div class="rounded-lg bg-rose-500/10 px-3 py-2.5 text-[13px] leading-relaxed text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300">
            <p class="font-semibold">This is permanent. There is no undo.</p>
            <p>Deleting {{ project.name }} throws away {{ loses.join(', ') }}. Sessions on it stop getting anything.</p>
            <p class="mt-1 text-xs opacity-80">Only the iCloud backups keep a copy: the daily ones for two weeks, the latest until the next change replaces it.</p>
          </div>
          <label class="flex flex-col gap-1 text-xs text-muted">
            <span>Type <span class="font-mono font-medium text-fg">{{ project.id }}</span> to confirm</span>
            <input v-model="typed" autocomplete="off" spellcheck="false" aria-label="Type the project's id to confirm" class="h-8 w-64 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line focus:ring-rose-500/50 focus:outline-none">
          </label>
          <div class="flex items-center gap-2">
            <UiButton type="submit" variant="danger" size="md" :disabled="typed !== project.id || removing">
              <UiBusy :busy="removing" label="Deleting…">{{ `Delete ${project.name} forever` }}</UiBusy>
            </UiButton>
            <UiButton size="md" @click="deleting = false; typed = ''">Cancel</UiButton>
            <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
          </div>
        </form>
      </section>
    </div>
    <NotFound v-else-if="ready" reason="It may have been renamed or deleted." to="/mine" back="Go to My issues">No project “{{ route.params.project }}”</NotFound>
    <UiLoading v-else />
  </div>
</template>
