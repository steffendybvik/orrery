<script setup lang="ts">
import type {Project, Schedule} from '#shared/roadmap'

// A project's schedules as a card: the project at its head, with its own New schedule, then its schedules, soonest
// first, paused (and one-offs that have run) last. A row says what it does (makes an issue, or messages the
// sessions) and what it says, when it repeats, when it runs next and how its last run went; clicking edits it,
// right-clicking or its ⋯ opens its menu (run now, pause, edit, remove). Its play button leads the row and says
// its state at a glance, like a music player's: a filled one with ❙❙ while it runs (press to pause), an outlined
// one with ▶ while it's paused.
const props = defineProps<{project: Project, schedules: Schedule[]}>()
const {edit, openMenu, pause} = useSchedules()
const {open: openIssue} = useIssueLink()

// Ticks once a minute, so "in 5m" stays right.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => clock = setInterval(() => now.value = Date.now(), 60_000))
onBeforeUnmount(() => clearInterval(clock))

const sorted = computed(() => [...props.schedules].sort((a, b) => (a.enabled && a.next_run ? a.next_run : '~').localeCompare(b.enabled && b.next_run ? b.next_run : '~')))
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
const ran = (s: Schedule) => !!s.at && !s.enabled
/** The first line of what it says, for a glance at what it's for. */
const gist = (s: Schedule) => s.notes?.split('\n').find(line => line.trim())?.replace(/^[#>*\-\s]+/, '') ?? ''

const OUTCOME = {
    made: 'text-emerald-600 dark:text-emerald-400',
    sent: 'text-emerald-600 dark:text-emerald-400',
    skipped: 'text-faint',
    failed: 'text-rose-600 dark:text-rose-400',
}
</script>

<template>
  <section :id="`schedules-${project.id}`" class="flex scroll-mt-14 flex-col overflow-hidden rounded-xl border border-line bg-panel">
    <header class="flex items-center gap-2 border-b border-line bg-well/60 px-4 py-2.5">
      <NuxtLink :to="`/p/${project.id}`" class="flex min-w-0 items-center gap-2 hover:text-accent-600 dark:hover:text-accent-400">
        <ProjectIcon v-if="project.icon && heroicon(project.icon)" :icon="project.icon" :color="project.icon_color" class="size-4" />
        <ProgressRing v-else :kinds="project.board.kinds" bare :size="16" />
        <h2 class="truncate text-[14px] font-semibold">{{ project.name }}</h2>
      </NuxtLink>
      <span class="shrink-0 text-xs text-faint">{{ active }} running<template v-if="schedules.length - active">, {{ schedules.length - active }} paused</template></span>
      <UiButton class="ml-auto shrink-0" :aria-label="`New schedule in ${project.name}`" @click="edit(project.id)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New schedule
      </UiButton>
    </header>
    <p v-if="!schedules.length" class="px-4 py-6 text-center text-[13px] text-faint">Nothing scheduled here yet.</p>
    <div
        v-for="s in sorted"
        :key="s.id"
        data-nav
        tabindex="0"
        role="button"
        class="group flex cursor-pointer items-center gap-3 border-b border-line/60 px-4 py-3 text-sm outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-active"
        @click="edit(s.project, s)"
        @contextmenu="openMenu($event, s)"
    >
      <button
          v-if="!ran(s)"
          type="button"
          class="grid size-9 shrink-0 place-items-center rounded-full transition hover:scale-105 active:scale-95 disabled:opacity-50"
          :class="s.enabled
            ? 'bg-accent-500 text-zinc-950 shadow-sm shadow-accent-600/30 hover:bg-accent-400'
            : 'border-2 border-line text-muted hover:border-accent-500 hover:text-accent-600 dark:hover:text-accent-400'"
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
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate font-medium text-fg">{{ s.title }}</span>
          <span
              class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium"
              :class="s.kind === 'message' ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300' : 'bg-accent-500/12 text-accent-700 dark:text-accent-300'"
          >{{ s.kind === 'message' ? s.untrusted ? 'Own locked-down session' : 'Messages sessions' : 'Makes an issue' }}</span>
        </div>
        <span v-if="gist(s)" class="truncate text-xs text-muted">{{ gist(s) }}</span>
        <span class="truncate text-xs text-faint">
          {{ describe(s) }}<template v-if="s.kind === 'issue' && s.ask"> · asks the sessions</template><template v-if="s.kind === 'issue' && s.priority"> · {{ s.priority }}</template><template v-if="s.kind === 'issue' && s.labels.length"> · {{ s.labels.join(', ') }}</template>
        </span>
      </div>
      <span v-if="s.runs[0]" class="hidden shrink-0 items-center gap-1 self-start pt-0.5 text-xs md:flex" :class="[OUTCOME[s.runs[0].outcome], !s.enabled && 'opacity-60']" :title="s.runs[0].note ?? ''">
        <template v-if="s.runs[0].outcome === 'made'">
          ✓ made
          <button type="button" class="font-mono hover:underline" @click.stop="openIssue(s.project, s.runs[0].issue!)">{{ s.runs[0].issue }}</button>
        </template>
        <template v-else>{{ {sent: '✉ sent', skipped: '⤼ skipped', failed: '✗ failed'}[s.runs[0].outcome] }}</template>
        <span class="text-faint">· {{ ago(s.runs[0].at) }}</span>
      </span>
      <span class="shrink-0 self-start pt-0.5 text-right text-xs sm:w-36" :title="s.next_run ? when(s.next_run) : ''">
        <template v-if="s.enabled && s.next_run"><span class="text-fg">{{ soon(s.next_run) }}</span> <span class="hidden text-faint sm:inline">· {{ when(s.next_run).replace(/^\w+ \d+ \w+ /, '') }}</span></template>
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
