<script setup lang="ts">
import type {Issue, Preset, Project} from '#shared/roadmap'
import type {LaunchState} from '~/composables/useLaunchState'

// Starting Claude sessions from anywhere, as the owner: pick the projects (every one, those that can't start one
// now shown with why, and how to change that), one session each. On one project it can focus on an open issue;
// else it works through a scope, the issues of the statuses ticked (and of a release), most urgent first, or with
// nothing ticked waits for your work. It can be given more context: presets (the Orrery's, and each project's own)
// and your own words, which go with every signal to it. Their launchers start them in tmux, for each project's
// minutes; the project's Sessions tab shows them arriving.
const {target, close} = useStartSession()
const {launchers, sessions} = useRoadmaps()
const {ordered} = useProjectOrder()
const {load} = useOwner()
const {places} = useStatuses()
const router = useRouter()

const chosen = ref<string[]>([])
const issue = ref('')
/** The statuses ticked for the scope; the open work that's ready to begin with. */
const statuses = ref<string[]>([])
const release = ref('')
const busy = ref(false)
const failed = ref('')
const states = ref<Record<string, LaunchState | null>>({})
/** The presets the chosen projects' sessions can have, the Orrery's first; those ticked, and your own words. */
const presets = ref<Preset[]>([])
const picked = ref<number[]>([])
const instructions = ref('')

/** Whether a launcher is there and how many are running, for each project that lets Orrery start sessions. */
async function loadStates() {
    const asked = await Promise.all(ordered.value.filter(p => p.starts).map(async p =>
        [p.id, await $fetch<LaunchState>(`/api/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)] as const))
    states.value = Object.fromEntries(asked)
}

/** The statuses a scope can take: the open ones, in the order an issue moves through them. */
const open = computed(() => places.value.filter(p => p.kind !== 'proposed' && !isClosed(p.kind)))

watch(target, now => {
    if (!now) return
    chosen.value = now.project ? [now.project] : []
    issue.value = release.value = failed.value = instructions.value = ''
    picked.value = []
    statuses.value = open.value.filter(p => p.kind === 'todo' || p.kind === 'started').map(p => p.id)
    loadStates()
})
// Asked again as launchers come and go and sessions start, while it's open.
watch([launchers, sessions], () => target.value && loadStates())
watch(chosen, () => {
    issue.value = ''
    if (release.value && !releases.value.includes(release.value)) release.value = ''
    loadPresets()
})

async function loadPresets() {
    const lists = await Promise.all([
        $fetch<Preset[]>('/api/presets').catch(() => []),
        ...chosen.value.map(id => $fetch<Preset[]>(`/api/projects/${encodeURIComponent(id)}/presets`).then(all => all.filter(p => p.project)).catch(() => [])),
    ])
    presets.value = lists.flat()
    picked.value = picked.value.filter(id => presets.value.some(p => p.id === id))
}
const projectName = (id: string) => ordered.value.find(p => p.id === id)?.name ?? id

function pick(id: number) {
    picked.value = picked.value.includes(id) ? picked.value.filter(p => p !== id) : [...picked.value, id]
}

/** Why the project can't start a session now, if it can't. */
function why(project: Project): string | null {
    if (!project.starts) return "Doesn't let Orrery start sessions"
    const state = states.value[project.id]
    if (!state) return null
    if (!state.launchers) return 'No launcher running'
    if (state.started + state.starting >= project.starts.limit) return `At its limit of ${project.starts.limit}`
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

/** The project's issues a session started now would work through, as the server picks them: every chunk's,
 * or with a release those set for it at any depth, of the ticked statuses (or every open one). */
function scopeOf(project: Project): Issue[] {
    const tasks: Issue[] = []
    const pick = (issues: Issue[]) => issues.forEach(t => t.release === release.value ? tasks.push(t) : pick(t.tasks))
    const top = project.board.chunks.flatMap(c => c.tasks)
    if (release.value) pick(top)
    else tasks.push(...top)
    return tasks.filter(t => statuses.value.length ? statuses.value.includes(t.column) : t.kind !== 'proposed' && !isClosed(t.kind))
}

const ready = computed(() => projects.value.length > 0 && projects.value.every(p => !why(p) && !!states.value[p.id]) && !busy.value)

function toggle(status: string) {
    statuses.value = statuses.value.includes(status) ? statuses.value.filter(s => s !== status) : [...statuses.value, status]
}

async function start() {
    if (!ready.value) return
    busy.value = true
    failed.value = ''
    const actor = await load()
    const work = issue.value ? {issue: issue.value} : scoped.value ? {statuses: statuses.value, ...release.value ? {release: release.value} : {}} : {}
    // Each project's session gets the Orrery's presets ticked and its own.
    const body = (project: string) => ({
        ...work,
        presets: picked.value.filter(id => presets.value.some(p => p.id === id && (!p.project || p.project === project))),
        ...instructions.value.trim() ? {instructions: instructions.value.trim()} : {},
    })
    const refused = new Map<string, string>()
    let first: string | undefined
    for (const p of projects.value) {
        try {
            await $fetch(`/api/projects/${encodeURIComponent(p.id)}/launches`, {method: 'POST', headers: {'Orrery-Actor': actor}, body: body(p.id)})
            first ??= p.id
        } catch (error) {
            refused.set(p.id, `${p.name}: ${errorMessage(error)}`)
        }
    }
    busy.value = false
    if (refused.size) {
        // Those that started are on their way; only the refused stay ticked, to try again.
        chosen.value = chosen.value.filter(id => refused.has(id))
        failed.value = [...refused.values()].join(' · ')
        loadStates()
        return
    }
    close()
    if (first) router.push(`/p/${first}/sessions`)
}

const field = 'h-8 w-full rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <Teleport to="body">
    <div v-if="target" class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" @pointerdown.self="close">
      <form class="glass flex max-h-[76vh] w-full max-w-lg animate-fade-up flex-col gap-3 rounded-2xl p-5" role="dialog" aria-label="Start session" @submit.prevent="start" @keydown.esc.stop="close" @keydown.meta.enter.prevent="start" @keydown.ctrl.enter.prevent="start">
        <div class="flex items-center gap-2 text-xs text-faint">
          <span>Start a Claude session</span>
          <KeyHint class="ml-auto">esc</KeyHint>
        </div>

        <div class="flex min-h-0 flex-col gap-1">
          <span class="label px-1">Projects <span class="font-normal normal-case text-faint">· a session each</span></span>
          <div class="flex min-h-0 flex-col gap-0.5 overflow-y-auto" role="group" aria-label="Projects">
            <label
                v-for="p in ordered"
                :key="p.id"
                class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]"
                :class="why(p) ? 'text-faint' : chosen.includes(p.id) ? 'bg-accent-500/10 text-fg' : 'cursor-pointer text-muted hover:bg-hover hover:text-fg'"
            >
              <input v-model="chosen" type="checkbox" name="project" :value="p.id" :disabled="!!why(p)" class="accent-accent-500">
              <ProjectIcon v-if="p.icon && heroicon(p.icon)" :icon="p.icon" :color="p.icon_color" class="size-3.5" />
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span v-if="why(p)" class="shrink-0 text-xs">
                {{ why(p) }}<template v-if="!p.starts"> · <NuxtLink :to="`/p/${p.id}/sessions#starts`" class="text-accent-600 hover:underline dark:text-accent-400" @click="close">turn it on</NuxtLink></template>
              </span>
              <span v-else-if="p.starts" class="shrink-0 text-xs text-faint">
                <template v-if="chosen.includes(p.id) && scoped">{{ scopeOf(p).length }} {{ scopeOf(p).length === 1 ? 'issue' : 'issues' }} · </template>{{ p.starts.minutes }} min
              </span>
            </label>
          </div>
        </div>

        <label v-if="one" class="flex flex-col gap-1">
          <span class="label px-1">Focus on (optional)</span>
          <select v-model="issue" aria-label="Issue" :class="field">
            <option value="">No one issue: it works through what's below</option>
            <option v-for="i in openIssues" :key="i.id" :value="i.id">{{ i.id }} · {{ i.title }}</option>
          </select>
        </label>

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
          <select v-if="releases.length" v-model="release" aria-label="Release" :class="field">
            <option value="">Any release</option>
            <option v-for="v in releases" :key="v" :value="v">Release {{ v }}</option>
          </select>
          <p class="px-1 text-xs text-faint">
            {{ scoped ? 'It works through these issues, most urgent first, one at a time.' : 'Nothing ticked: it waits for your work.' }}
          </p>
        </div>

        <div v-if="projects.length" class="flex flex-col gap-1.5">
          <span class="label px-1">Context <span class="font-normal normal-case text-faint">· optional, goes with every signal to it</span></span>
          <div v-if="presets.length" class="flex flex-wrap gap-1.5" role="group" aria-label="Presets">
            <button
                v-for="p in presets"
                :key="p.id"
                type="button"
                :aria-pressed="picked.includes(p.id)"
                :title="p.text"
                class="flex h-7 items-center gap-1 rounded-full px-2.5 text-xs ring-1"
                :class="picked.includes(p.id) ? 'bg-accent-500/10 text-fg ring-accent-500/40' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
                @click="pick(p.id)"
            >
              {{ p.name }}<span v-if="p.project && projects.length > 1" class="text-faint">· {{ projectName(p.project) }}</span>
            </button>
          </div>
          <textarea
              v-model="instructions"
              rows="2"
              aria-label="Your own instructions"
              placeholder="Anything else it should know, e.g. run the e2e suite before you finish"
              class="w-full rounded-lg bg-well px-2.5 py-2 text-[13px] leading-5 text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
          />
          <p v-if="!presets.length" class="px-1 text-xs text-faint">
            Context you give often can be saved as a preset on <NuxtLink to="/settings#presets" class="text-accent-600 hover:underline dark:text-accent-400" @click="close">App settings</NuxtLink>.
          </p>
        </div>

        <div class="flex items-center gap-2 border-t border-line pt-3">
          <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <button type="submit" class="ml-auto flex h-8 items-center gap-2 rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="!ready">
            {{ busy ? 'Starting…' : 'Start session' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
