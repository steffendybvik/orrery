<script setup lang="ts">
import type {Issue, Preset, Project} from '#shared/roadmap'
import type {LaunchState} from '~/composables/useLaunchState'

// Starting Claude sessions from anywhere, as the owner: pick the projects (every one, those that can't start one
// now shown with why, and how to change that), one session each, hearing only its project; or, when the projects
// picked are served from one repo, one session there hearing them all; or none, for one session hearing every
// project, where a launcher's channel serves them all (`*`). On one project it can focus on an open issue;
// else it works through a scope, the issues of the statuses ticked (and of a release), most urgent first, or with
// nothing ticked waits for your work. It can be given more context: presets (the orrery's, and each project's own)
// and your own words, which go with every signal to it. Several at once can be started of each, as many as the limit
// has room for, each taking a different issue of the scope (a session on one issue is never joined by another).
// Their launchers start them in tmux, for each project's minutes or until stopped; the Sessions page shows them arriving.
const {target, close} = useStartSession()
const {launchers, sessions, byId} = useRoadmaps()
const {ordered} = useProjectOrder()
const {places} = useStatuses()
const router = useRouter()

/** The most sessions to start at once of each, when the limit isn't known yet. */
const MOST = 9
const chosen = ref<string[]>([])
const issue = ref('')
/** The statuses ticked for the scope; the open work that's ready to begin with. */
const statuses = ref<string[]>([])
const release = ref('')
const busy = ref(false)
const failed = ref('')
const states = ref<Record<string, LaunchState | null>>({})
/** The presets the chosen projects' sessions can have, the orrery's first; those ticked, and your own words. */
const presets = ref<Preset[]>([])
const picked = ref<number[]>([])
const instructions = ref('')
/** One session for every project picked, rather than one each, when they share a repo. */
const together = ref<'one' | 'each'>('one')
/** How many sessions to start of each: every project's, or the one for all. */
const count = ref(1)

/** Whether a launcher is there and how many are running, for each project that lets orrery start sessions. */
async function loadStates() {
    const asked = await Promise.all(ordered.value.filter(p => p.starts).map(async p =>
        [p.id, await apiFetch<LaunchState>(`/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)] as const))
    states.value = Object.fromEntries(asked)
}

/** The statuses a scope can take: the open ones, in the order an issue moves through them. */
const open = computed(() => places.value.filter(p => p.kind !== 'proposed' && !isClosed(p.kind)))

watch(target, now => {
    if (!now) return
    chosen.value = now.project ? [now.project] : []
    issue.value = release.value = failed.value = instructions.value = ''
    picked.value = []
    together.value = 'one'
    count.value = 1
    statuses.value = open.value.filter(p => p.kind === 'todo' || p.kind === 'started').map(p => p.id)
    loadStates()
}, {immediate: true})
// Asked again as launchers come and go and sessions start, while it's open.
watch([launchers, sessions], () => target.value && loadStates())
// At once as well: opening sets `chosen` above, before this watches it, and with nothing ticked the orrery's presets
// would otherwise never load.
watch(chosen, () => {
    issue.value = ''
    if (release.value && !releases.value.includes(release.value)) release.value = ''
    loadPresets()
}, {immediate: true})

async function loadPresets() {
    const lists = await Promise.all([
        apiFetch<Preset[]>('/presets').catch(() => []),
        ...chosen.value.map(id => apiFetch<Preset[]>(`/projects/${encodeURIComponent(id)}/presets`).then(all => all.filter(p => p.project)).catch(() => [])),
    ])
    presets.value = lists.flat()
    picked.value = picked.value.filter(id => presets.value.some(p => p.id === id))
}
const projectName = (id: string) => byId(id)?.name ?? id

function pick(id: number) {
    picked.value = picked.value.includes(id) ? picked.value.filter(p => p !== id) : [...picked.value, id]
}

/** Why the project can't start a session now, if it can't. */
function why(project: Project): string | null {
    if (!project.starts) return "orrery doesn't start sessions"
    const state = states.value[project.id]
    if (!state) return null
    if (!state.launchers) return 'No launcher running'
    if (state.total >= project.starts.limit) return `At the limit of ${project.starts.limit}`
    return null
}

const projects = computed(() => ordered.value.filter(p => chosen.value.includes(p.id)))
const one = computed(() => projects.value.length === 1 ? projects.value[0] : undefined)
const openIssues = computed(() => one.value
    ? allIssues(one.value).map(({issue}) => issue).filter(i => i.kind !== 'proposed' && !isClosed(i.kind))
    : [])
/** The releases every chosen project can ship in. */
const releases = computed(() => {
    const lists = projects.value.map(p => p.releases.filter(r => !r.shipped_on).map(r => r.version))
    return lists.length ? lists.reduce((all, list) => all.filter(v => list.includes(v))) : []
})
const scoped = computed(() => !issue.value && (statuses.value.length > 0 || !!release.value))
// For the pickers, which find as you type, as on an issue's page.
const issueOptions = computed(() => [{value: '', label: "No one issue: it works through what's below"}, ...openIssues.value.map(i => ({value: i.id, label: `${i.id} · ${i.title}`}))])
const issueLabel = computed(() => issueOptions.value.find(o => o.value === issue.value)?.label)
const releaseOptions = computed(() => [{value: '', label: 'Any release'}, ...releases.value.map(v => ({value: v, label: `Release ${v}`}))])

/** The project's issues a session started now would work through, as the server picks them: every chunk's,
 * or with a release those set for it at any depth, of the ticked statuses (or, with none, the open work that's ready:
 * Todo and In progress, as the server's `SCOPE_STATUSES`). */
function scopeOf(project: Project): Issue[] {
    const tasks: Issue[] = []
    const pick = (issues: Issue[]) => issues.forEach(t => t.release === release.value ? tasks.push(t) : pick(t.tasks))
    const top = project.board.chunks.flatMap(c => c.tasks)
    if (release.value) pick(top)
    else tasks.push(...top)
    return tasks.filter(t => statuses.value.length ? statuses.value.includes(t.column) : t.kind === 'todo' || t.kind === 'started')
}

/** Whether the projects picked are served from one repo (a launcher folder in common), so one session can hear them all. */
const shared = computed(() => {
    const [first, ...rest] = projects.value
    return !!first && rest.length > 0
        && (states.value[first.id]?.folders ?? []).some(dir => rest.every(p => states.value[p.id]?.folders.includes(dir)))
})
const oneSession = computed(() => shared.value && together.value === 'one')
const ways = computed(() => [{value: 'one' as const, label: `One session for all ${projects.value.length}`}, {value: 'each' as const, label: 'A session each'}])

/** With nothing ticked, the project whose launcher starts a session hearing every project: the first that can start
 * one now where its channel serves them all. */
const everywhere = computed(() => projects.value.length ? undefined : ordered.value.find(p => !why(p) && states.value[p.id]?.every))

/** The sessions one of the count starts: one for all, or one for every project picked. */
const launches = computed(() => everywhere.value || oneSession.value ? 1 : Math.max(projects.value.length, 1))
/** The most of each that can start now: one on a single issue, else as many as the limit has room for, which counts
 * the sessions on every project. */
const most = computed(() => {
    if (issue.value) return 1
    const asked = everywhere.value ? [everywhere.value] : projects.value
    const room = Math.min(...asked.map(p => {
        const state = states.value[p.id]
        return p.starts && state ? p.starts.limit - state.total : Infinity
    }))
    return Number.isFinite(room) ? Math.max(Math.floor(room / launches.value), 1) : MOST
})
watch(most, now => count.value = Math.min(count.value, now))

const ready = computed(() => !busy.value && (projects.value.length
    ? projects.value.every(p => !why(p) && !!states.value[p.id])
    : !!everywhere.value))

function toggle(status: string) {
    statuses.value = statuses.value.includes(status) ? statuses.value.filter(s => s !== status) : [...statuses.value, status]
}

async function start() {
    if (!ready.value) return
    busy.value = true
    failed.value = ''
    const work = issue.value ? {issue: issue.value} : scoped.value ? {statuses: statuses.value, ...release.value ? {release: release.value} : {}} : {}
    const own = instructions.value.trim() ? {instructions: instructions.value.trim()} : {}
    // Each project's session gets the orrery's presets ticked and its own.
    const body = (project: string) => ({
        ...work,
        presets: picked.value.filter(id => presets.value.some(p => p.id === id && (!p.project || p.project === project))),
        ...own,
    })
    const refused = new Map<string, string>()
    // The count of them through the project's launcher, stopping at the first refused, as the rest would be too.
    const launch = async (id: string, name: string | null, sent: object) => {
        for (let n = 0; n < count.value; n++) {
            try {
                await apiFetch(`/projects/${encodeURIComponent(id)}/launches`, {method: 'POST', body: sent})
            } catch (error) {
                refused.set(id, `${name ? `${name}: ` : ''}${n ? `${n} of ${count.value} started, then ` : ''}${errorMessage(error)}`)
                return
            }
        }
    }
    // Without `hears`, so it hears what its channel serves: every project. Nothing ticked, so no work is set.
    if (everywhere.value) await launch(everywhere.value.id, everywhere.value.name, {presets: picked.value, ...own})
    if (oneSession.value) {
        // Started from the first project's launcher, hearing every one picked, with every preset ticked.
        const first = projects.value[0]?.id ?? ''
        await launch(first, null, {...body(first), presets: picked.value, hears: projects.value.map(p => p.id)})
    }
    for (const p of oneSession.value ? [] : projects.value) await launch(p.id, p.name, {...body(p.id), hears: [p.id]})
    busy.value = false
    if (refused.size) {
        // Those that started are on their way; only the refused stay ticked, to try again (all of them, for one session).
        if (!oneSession.value) chosen.value = chosen.value.filter(id => refused.has(id))
        failed.value = [...refused.values()].join(' · ')
        loadStates()
        return
    }
    close()
    // They're listed with every other session, on the Sessions page.
    router.push('/sessions')
}

</script>

<template>
  <UiDialog :open="target" label="Start session" class="max-h-[76vh]" @close="close" @submit="start">
    <div class="flex items-center gap-2 text-xs text-faint">
      <span>Start a session</span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>

    <div class="flex min-h-0 flex-col gap-1">
      <span class="label px-1">Projects <span class="font-normal normal-case text-faint">· {{ !projects.length ? 'none ticked: one session hearing every project' : oneSession ? 'one session hearing them all' : 'a session each' }}</span></span>
      <div class="flex min-h-0 flex-col gap-0.5 overflow-y-auto" role="group" aria-label="Projects">
        <label
            v-for="p in ordered"
            :key="p.id"
            class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]"
            :class="why(p) ? 'text-faint' : chosen.includes(p.id) ? 'bg-accent-500/10 text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
        >
          <input v-model="chosen" type="checkbox" name="project" :value="p.id" :disabled="!!why(p)" class="accent-accent-500">
          <ProjectIcon v-if="p.icon && heroicon(p.icon)" :icon="p.icon" :color="p.icon_color" class="size-3.5" />
          <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
          <span v-if="why(p)" class="shrink-0 text-xs">
            {{ why(p) }}<template v-if="!p.starts"> · <NuxtLink to="/sessions#starts" class="text-accent-700 hover:underline dark:text-accent-400" @click="close">turn it on</NuxtLink></template>
          </span>
          <span v-else-if="p.starts" class="shrink-0 text-xs text-faint">
            <template v-if="chosen.includes(p.id) && scoped">{{ scopeOf(p).length }} {{ scopeOf(p).length === 1 ? 'issue' : 'issues' }} · </template>{{ p.starts.minutes ? `${p.starts.minutes} min` : 'until stopped' }}
          </span>
        </label>
      </div>
    </div>

    <p v-if="!projects.length" class="px-1 text-xs text-faint">
      <template v-if="everywhere">One session hearing every project, projects made later too, started in {{ everywhere.name }}'s repo.</template>
      <template v-else>Tick a project to start. For one session hearing every project, a launcher has to run in a repo whose <code>.mcp.json</code> gives the channel <code>ORRERY_PROJECTS=*</code>.</template>
    </p>

    <div v-if="shared" class="flex items-center gap-2 px-1">
      <SegmentedControl v-model="together" :options="ways" class="shrink-0 [&_[role=radio]]:whitespace-nowrap" />
      <span class="text-xs text-faint">{{ oneSession ? 'They share a repo, so one session there can work them all.' : 'Each hears only its own project.' }}</span>
    </div>

    <div v-if="one" class="flex flex-col gap-1">
      <span class="label px-1">Focus on (optional)</span>
      <PropertyPicker v-model="issue" :options="issueOptions" label="Issue" placeholder="Find an issue by id or title…" wide>
        <span class="truncate" :class="!issue && 'text-faint'">{{ issueLabel }}</span>
      </PropertyPicker>
    </div>

    <div v-if="projects.length && !issue" class="flex flex-col gap-1.5">
      <span class="label px-1">Work through</span>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Statuses">
        <button
            v-for="s in open"
            :key="s.id"
            type="button"
            :aria-pressed="statuses.includes(s.id)"
            class="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1"
            :class="statuses.includes(s.id) ? 'bg-accent-500/10 text-fg ring-accent-500/40' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
            @click="toggle(s.id)"
        >
          <StatusIcon :column="s.id" :size="12" />{{ s.label }}
        </button>
      </div>
      <PropertyPicker v-if="releases.length" v-model="release" :options="releaseOptions" label="Release">
        <span class="truncate" :class="!release && 'text-faint'">{{ release ? `Release ${release}` : 'Any release' }}</span>
      </PropertyPicker>
      <p class="px-1 text-xs text-faint">
        {{ scoped ? 'It works through these issues, most urgent first, one at a time.' : 'Nothing ticked: it waits for your work.' }}
      </p>
    </div>

    <div v-if="projects.length || everywhere" class="flex flex-col gap-1.5">
      <span class="label px-1">Context <span class="font-normal normal-case text-faint">· optional, goes with every signal to it</span></span>
      <div v-if="presets.length" class="grid grid-cols-1 gap-1.5 sm:grid-cols-2" role="group" aria-label="Presets">
        <button
            v-for="p in presets"
            :key="p.id"
            type="button"
            :aria-pressed="picked.includes(p.id)"
            :title="p.text"
            class="flex min-w-0 items-center gap-2 rounded-lg p-2 text-left ring-1 transition-colors"
            :class="picked.includes(p.id) ? 'bg-accent-500/10 ring-accent-500/50' : 'ring-line hover:bg-hover'"
            @click="pick(p.id)"
        >
          <PresetBadge :preset="p" :size="24" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-xs font-medium text-fg">{{ p.name }}<span v-if="p.project && projects.length > 1" class="font-normal text-faint"> · {{ projectName(p.project) }}</span></span>
            <span class="truncate text-[11px] text-muted">{{ firstLine(p.text) }}</span>
          </span>
          <span
              class="grid size-4 shrink-0 place-items-center rounded-full"
              :class="picked.includes(p.id) ? 'bg-accent-fill text-on-accent' : 'ring-1 ring-inset ring-line'"
          >
            <svg v-if="picked.includes(p.id)" class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          </span>
        </button>
      </div>
      <textarea
          v-model="instructions"
          rows="2"
          aria-label="Your own instructions"
          placeholder="Anything else it should know, e.g. run the e2e suite before you finish"
          class="w-full field py-2 leading-5"
      />
      <p v-if="!presets.length" class="px-1 text-xs text-faint">
        Context you give often can be saved as a preset under <NuxtLink to="/sessions#presets" class="text-accent-700 hover:underline dark:text-accent-400" @click="close">Presets</NuxtLink> on the Sessions page.
      </p>
    </div>

    <div class="flex items-center gap-2 border-t border-line pt-3">
      <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
      <label v-if="most > 1" class="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-faint" :title="`At most ${most} under the limit`">
        <input v-model.number="count" type="number" min="1" :max="most" aria-label="Sessions to start" class="h-8 w-14 field" @change="count = Math.min(Math.max(Math.floor(count) || 1, 1), most)">
        <template v-if="launches > 1">each, {{ count * launches }} in all</template>
      </label>
      <UiButton type="submit" variant="primary" size="md" :class="most > 1 ? '' : 'ml-auto'" :disabled="!ready">
        {{ busy ? 'Starting…' : count * launches > 1 ? `Start ${count * launches} sessions` : 'Start session' }} <KeyHint class="bg-black/10 text-on-accent ring-0">⌘↵</KeyHint>
      </UiButton>
    </div>
  </UiDialog>
</template>
