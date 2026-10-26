<script setup lang="ts">
import type {Project} from '#shared/roadmap'
import type {LaunchState} from '~/composables/useLaunchState'

// Starting a Claude session from anywhere, as the owner: pick the project (every one, those that can't start one
// now shown with why, and how to change that), then optionally an open issue for it to focus on from the start.
// Its launcher starts it in tmux, for the project's minutes; the project's Sessions tab shows it arriving.
const {target, close} = useStartSession()
const {launchers, sessions} = useRoadmaps()
const {ordered} = useProjectOrder()
const {load} = useOwner()
const router = useRouter()

const chosen = ref<string | null>(null)
const issue = ref('')
const busy = ref(false)
const failed = ref('')
const states = ref<Record<string, LaunchState | null>>({})

/** Whether a launcher is there and how many are running, for each project that lets Orrery start sessions. */
async function loadStates() {
    const asked = await Promise.all(ordered.value.filter(p => p.starts).map(async p =>
        [p.id, await $fetch<LaunchState>(`/api/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)] as const))
    states.value = Object.fromEntries(asked)
}

watch(target, now => {
    if (!now) return
    chosen.value = now.project
    issue.value = failed.value = ''
    loadStates()
})
// Asked again as launchers come and go and sessions start, while it's open.
watch([launchers, sessions], () => target.value && loadStates())
watch(chosen, () => issue.value = '')

/** Why the project can't start a session now, if it can't. */
function why(project: Project): string | null {
    if (!project.starts) return "Doesn't let Orrery start sessions"
    const state = states.value[project.id]
    if (!state) return null
    if (!state.launchers) return 'No launcher running'
    if (state.started + state.starting >= project.starts.limit) return `At its limit of ${project.starts.limit}`
    return null
}

const project = computed(() => ordered.value.find(p => p.id === chosen.value))
const openIssues = computed(() => project.value
    ? allIssues(project.value).map(({issue}) => issue).filter(i => i.kind !== 'proposed' && !isClosed(i.kind))
    : [])
const ready = computed(() => !!project.value && !why(project.value) && !!states.value[project.value.id] && !busy.value)

async function start() {
    if (!ready.value || !project.value) return
    busy.value = true
    failed.value = ''
    const at = project.value.id
    try {
        await $fetch(`/api/projects/${encodeURIComponent(at)}/launches`, {
            method: 'POST',
            headers: {'Orrery-Actor': await load()},
            body: issue.value ? {issue: issue.value} : {},
        })
        close()
        router.push(`/p/${at}/sessions`)
    } catch (error) {
        failed.value = errorMessage(error)
        loadStates()
    } finally {
        busy.value = false
    }
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
          <span class="label px-1">Project</span>
          <div class="flex min-h-0 flex-col gap-0.5 overflow-y-auto" role="radiogroup" aria-label="Project">
            <label
                v-for="p in ordered"
                :key="p.id"
                class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]"
                :class="why(p) ? 'text-faint' : chosen === p.id ? 'bg-accent-500/10 text-fg' : 'cursor-pointer text-muted hover:bg-hover hover:text-fg'"
            >
              <input v-model="chosen" type="radio" name="project" :value="p.id" :disabled="!!why(p)" class="accent-accent-500">
              <ProjectIcon v-if="p.icon && heroicon(p.icon)" :icon="p.icon" :color="p.icon_color" class="size-3.5" />
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span v-if="why(p)" class="shrink-0 text-xs">
                {{ why(p) }}<template v-if="!p.starts"> · <NuxtLink :to="`/p/${p.id}/sessions#starts`" class="text-accent-600 hover:underline dark:text-accent-400" @click="close">turn it on</NuxtLink></template>
              </span>
              <span v-else-if="p.starts" class="shrink-0 text-xs text-faint">{{ p.starts.minutes }} min</span>
            </label>
          </div>
        </div>

        <label v-if="project" class="flex flex-col gap-1">
          <span class="label px-1">Focus on (optional)</span>
          <select v-model="issue" aria-label="Issue" :class="field">
            <option value="">No issue: it waits for your work</option>
            <option v-for="i in openIssues" :key="i.id" :value="i.id">{{ i.id }} · {{ i.title }}</option>
          </select>
        </label>

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
