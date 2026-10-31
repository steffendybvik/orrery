<script setup lang="ts">
import {BoltIcon} from '@heroicons/vue/16/solid'
import type {Project, Schedule} from '#shared/roadmap'
import {canActivate} from '#shared/roadmap'

// A project's schedules as a card: the project at its head, with its own New schedule, then its schedules: running event
// ones first (they have no time to sort by and can fire at any moment, ORR-709), then soonest first, paused (and one-offs
// that have run) last. A row says what it does (makes an issue, messages the
// sessions or starts one) and what it says, when it repeats, when it runs next and how its last run went; clicking edits it,
// right-clicking or its ⋯ opens its menu (run now, pause, edit, remove). Its play button leads the row and says
// its state at a glance, like a music player's: a filled one with ❙❙ while it runs (press to pause), an outlined
// one with ▶ while it's paused. An agent's says who made it and whether it runs, and is tinted as unseen until it's
// opened, as issues are (ORR-456).
const props = defineProps<{project: Project, schedules: Schedule[]}>()
const {edit, openMenu, pause, setAll} = useSchedules()
const {scheduleUnseen} = useUnseen()
const {who} = useOwner()
/** An agent's: a message or session one doesn't run until the owner makes it theirs. */
const byAgent = (s: Schedule) => s.protected ? '' : `by ${who(s.created_by)}${s.kind === 'issue' ? '' : ' · not running until you make it yours'}`
const {places} = useStatuses()
/** The status an action schedule moves issues to, by its name. */
const movesTo = (s: Schedule) => places.value.find(p => p.id === s.column)?.label ?? s.column
const {open: openIssue} = useIssueLink()

// Ticks once a minute, so "in 5m" stays right.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => clock = setInterval(() => now.value = Date.now(), 60_000))
onBeforeUnmount(() => clearInterval(clock))

/** Where it sorts: `''` before any time, and `~` after them, by plain order, as `localeCompare` puts `~` before digits. */
const place = (s: Schedule) => !s.enabled ? '~' : s.on ? '' : s.next_run ?? '~'
const sorted = computed(() => [...props.schedules].sort((a, b) => place(a) < place(b) ? -1 : place(a) > place(b) ? 1 : 0))
const active = computed(() => props.schedules.filter(s => s.enabled).length)
/** How long until it runs, kept right by the clock. */
function soon(at: string): string {
    void now.value
    return until(at)
}

// The schedules being paused or resumed, so a double click doesn't send it twice.
const pausing = ref(new Set<number>())
async function togglePause(s: Schedule) {
    if (pausing.value.has(s.id)) return
    pausing.value.add(s.id)
    try {
        await pause(s, s.enabled)
    } catch {
        // The row stays as it was.
    } finally {
        pausing.value.delete(s.id)
    }
}
// Pause all and Activate all, on this project's schedules alone (ORR-783). Pausing goes at once; activating asks first, as
// it also turns on what was paused on purpose. Afterwards a line says how many changed, and names any that failed.
const pausable = computed(() => props.schedules.filter(s => s.enabled).length)
const activatable = computed(() => props.schedules.filter(canActivate).length)
const asking = ref(false)
const settingAll = ref(false)
const allDone = ref('')
const allFailed = ref('')
const count = (n: number) => `${n} ${n === 1 ? 'schedule' : 'schedules'}`
async function changeAll(enabled: boolean) {
    settingAll.value = true
    allDone.value = ''
    allFailed.value = ''
    try {
        const {changed, failed} = await setAll(props.project.id, enabled)
        allDone.value = `${enabled ? 'Activated' : 'Paused'} ${count(changed.length)}.`
        allFailed.value = failed.length ? `Couldn't change ${failed.map(f => `${f.title}: ${f.message}`).join('; ')}` : ''
    } catch (error) {
        allFailed.value = errorMessage(error)
    } finally {
        settingAll.value = false
        asking.value = false
    }
}
const ran = (s: Schedule) => !!s.at && !s.enabled
/** The first line of what it says, for a glance at what it's for. */
const gist = (s: Schedule) => s.notes?.split('\n').find(line => line.trim())?.replace(/^[#>*\-\s]+/, '') ?? ''

const OUTCOME = {
    made: 'text-emerald-600 dark:text-emerald-400',
    sent: 'text-emerald-600 dark:text-emerald-400',
    skipped: 'text-faint',
    failed: 'text-rose-700 dark:text-rose-400',
}
</script>

<template>
  <section :id="`schedules-${project.id}`" class="flex scroll-mt-14 flex-col overflow-hidden rounded-xl border border-line bg-panel">
    <header class="flex flex-wrap items-center gap-2 border-b border-line bg-well/60 px-4 py-2.5">
      <NuxtLink :to="`/p/${project.id}`" class="flex min-w-0 items-center gap-2 hover:text-accent-700 dark:hover:text-accent-400">
        <ProjectIcon v-if="project.icon && heroicon(project.icon)" :icon="project.icon" :color="project.icon_color" class="size-4" />
        <ProgressRing v-else :kinds="project.board.kinds" bare :size="16" />
        <h2 class="truncate text-[14px] font-semibold">{{ project.name }}</h2>
      </NuxtLink>
      <span class="shrink-0 text-xs text-faint">{{ active }} running<template v-if="schedules.length - active">, {{ schedules.length - active }} paused</template></span>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <UiButton :disabled="!pausable || settingAll" :aria-label="`Pause all in ${project.name}`" @click="changeAll(false)">Pause all</UiButton>
        <UiButton :disabled="!activatable || settingAll" :aria-label="`Activate all in ${project.name}`" @click="asking = true">Activate all</UiButton>
        <UiButton :aria-label="`New schedule in ${project.name}`" @click="edit(project.id)">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New schedule
        </UiButton>
      </div>
    </header>
    <div v-if="asking || allDone || allFailed" class="flex flex-col gap-1 border-b border-line/60 px-4 py-2 text-xs">
      <UiConfirm v-if="asking" inline action="Activate" busy-action="Activating…" size="xs" :busy="settingAll" @confirm="changeAll(true)" @cancel="asking = false">
        Activate {{ count(activatable) }}, including any paused on purpose?
      </UiConfirm>
      <p v-if="allDone" class="text-muted" role="status">{{ allDone }}</p>
      <p v-if="allFailed" class="text-rose-700 dark:text-rose-400" role="alert">{{ allFailed }}</p>
    </div>
    <p v-if="!schedules.length" class="px-4 py-6 text-center text-[13px] text-faint">Nothing scheduled here yet.</p>
    <div
        v-for="s in sorted"
        :key="s.id"
        data-nav
        tabindex="0"
        role="button"
        class="group flex items-center gap-3 border-b border-line/60 px-4 py-3 text-sm outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-active"
        :class="scheduleUnseen(s) && 'unseen-row'"
        @click="edit(s.project, s)"
        @contextmenu="openMenu($event, s)"
    >
      <button
          v-if="!ran(s)"
          type="button"
          class="grid size-9 shrink-0 place-items-center rounded-full transition hover:scale-105 active:scale-95 disabled:opacity-50"
          :class="s.enabled
            ? 'bg-accent-fill text-on-accent shadow-sm shadow-accent-600/30 hover:bg-accent-700 dark:hover:bg-accent-400'
            : 'border-2 border-line text-muted hover:border-accent-fill hover:text-accent-700 dark:hover:text-accent-400'"
          :disabled="pausing.has(s.id)"
          :title="s.enabled ? 'Running: pause it' : 'Paused: resume it'"
          :aria-label="`${s.enabled ? 'Pause' : 'Resume'} ${s.title}`"
          @click.stop="togglePause(s)"
      >
        <svg v-if="s.enabled" class="size-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1.5" /><rect x="14" y="4" width="5" height="16" rx="1.5" /></svg>
        <svg v-else class="ml-0.5 size-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" /></svg>
      </button>
      <span v-else class="grid size-9 shrink-0 place-items-center rounded-full border-2 border-dashed border-line text-faint" title="A one-off that has run">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5" :class="!s.enabled && 'opacity-60'">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 sm:flex-nowrap">
          <span v-if="scheduleUnseen(s)" class="unseen-dot" title="An agent made or changed it since you last opened it" />
          <span class="max-w-full truncate text-fg" :class="scheduleUnseen(s) ? 'font-semibold' : 'font-medium'">{{ s.title }}</span>
          <span
              class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium"
              :class="s.kind === 'message' ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300' : s.kind === 'session' ? 'bg-violet-500/12 text-violet-700 dark:text-violet-300' : s.kind === 'action' ? 'bg-amber-500/12 text-amber-800 dark:text-amber-300' : 'bg-accent-500/12 text-accent-700 dark:text-accent-300'"
          >{{ s.kind === 'message' ? s.untrusted ? 'Own locked-down session' : 'Messages sessions' : s.kind === 'session' ? 'Starts a session' : s.kind === 'action' ? 'Moves issues' : 'Makes an issue' }}</span>
        </div>
        <span v-if="s.across" class="truncate text-xs text-muted">Across projects: edit it here, or leave this project out from its ⋯</span>
        <span v-if="byAgent(s)" class="truncate text-xs text-amber-800 dark:text-amber-300">{{ byAgent(s) }}</span>
        <span v-if="gist(s)" class="truncate text-xs text-muted">{{ gist(s) }}</span>
        <span class="truncate text-xs text-faint">
          <BoltIcon v-if="s.on" class="mr-0.5 inline size-3 align-[-2px] text-teal-600 dark:text-teal-400" aria-hidden="true" />{{ describe(s) }}<template v-if="s.kind === 'action'"> · moves to {{ movesTo(s) }}</template><template v-if="s.held"> · {{ s.held }} waiting their turn</template><template v-if="s.kind === 'issue' && s.ask"> · asks the sessions</template><template v-if="s.kind === 'issue' && s.priority"> · {{ s.priority }}</template><template v-if="s.kind === 'issue' && s.labels.length"> · {{ s.labels.join(', ') }}</template>
        </span>
      </div>
      <span v-if="s.runs[0]" class="hidden shrink-0 items-center gap-1 self-start pt-0.5 text-xs md:flex" :class="[OUTCOME[s.runs[0].outcome], !s.enabled && 'opacity-60']" :title="s.runs[0].note ?? ''">
        <template v-if="s.runs[0].outcome === 'made' && s.runs[0].issue">
          ✓ {{ s.kind === 'action' ? 'moved' : 'made' }}
          <button type="button" class="font-mono hover:underline" @click.stop="openIssue(s.project, s.runs[0].issue!)">{{ s.runs[0].issue }}</button>
        </template>
        <template v-else>{{ {made: '✓ moved', sent: '✉ sent', skipped: '⤼ skipped', failed: '✗ failed'}[s.runs[0].outcome] }}</template>
        <span class="text-faint">· {{ ago(s.runs[0].at) }}</span>
      </span>
      <span class="shrink-0 self-start pt-0.5 text-right text-xs sm:w-36" :title="s.next_run ? when(s.next_run) : ''">
        <span v-if="s.enabled && s.on" class="inline-flex items-center gap-1 font-medium text-teal-700 dark:text-teal-300" :title="`Runs on ${s.on}, once per subject`"><BoltIcon class="size-3" aria-hidden="true" />On event</span>
        <template v-else-if="s.enabled && s.next_run"><span class="text-fg">{{ soon(s.next_run) }}</span> <span class="hidden text-faint sm:inline">· {{ when(s.next_run).replace(/^\w+ \d+ \w+ /, '') }}</span></template>
        <span v-else-if="ran(s)" class="text-faint">ran</span>
        <span v-else class="rounded-full bg-well px-2 py-0.5 font-medium text-muted">Paused</span>
      </span>
      <button
          type="button"
          class="grid size-7 shrink-0 place-items-center self-start rounded-md text-faint hover:bg-active hover:text-fg"
          :title="`More for ${s.title}: run now, pause, remove`"
          :aria-label="`More for ${s.title}`"
          @click.stop="openMenu($event, s)"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
      </button>
    </div>
  </section>
</template>
