<script setup lang="ts">
import type {Schedule} from '#shared/roadmap'

// Schedules as an agenda, by when they run next: today, tomorrow, this week, later, then paused (and
// one-offs that have run). A row says when it repeats, when it runs next and how its last run went;
// clicking edits it, right-clicking opens its menu, and its pause button (on hover, or while paused)
// pauses or resumes it.
const props = defineProps<{schedules: Schedule[]}>()
const {edit, openMenu, pause} = useSchedules()
const {open: openIssue} = useIssueLink()

// Ticks once a minute, so "in 5m" and the groups stay right.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => clock = setInterval(() => now.value = Date.now(), 60_000))
onBeforeUnmount(() => clearInterval(clock))

const groups = computed(() => {
    const start = new Date(now.value)
    start.setHours(0, 0, 0, 0)
    const day = 86_400_000
    const edges = [start.getTime() + day, start.getTime() + 2 * day, start.getTime() + 7 * day]
    const named = [
        {key: 'today', title: 'Today', items: [] as Schedule[]},
        {key: 'tomorrow', title: 'Tomorrow', items: [] as Schedule[]},
        {key: 'week', title: 'This week', items: [] as Schedule[]},
        {key: 'later', title: 'Later', items: [] as Schedule[]},
        {key: 'paused', title: 'Paused', items: [] as Schedule[]},
    ]
    for (const s of props.schedules) {
        if (!s.enabled || !s.next_run) {
            named[4]!.items.push(s)
            continue
        }
        const t = new Date(s.next_run).getTime()
        named[t < edges[0]! ? 0 : t < edges[1]! ? 1 : t < edges[2]! ? 2 : 3]!.items.push(s)
    }
    return named.filter(g => g.items.length)
})

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

const OUTCOME = {
    made: 'text-emerald-600 dark:text-emerald-400',
    sent: 'text-emerald-600 dark:text-emerald-400',
    skipped: 'text-faint',
    failed: 'text-rose-600 dark:text-rose-400',
}
</script>

<template>
  <div>
    <section v-for="group in groups" :key="group.key">
      <h2 class="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line bg-panel/90 px-4 text-[13px] font-medium backdrop-blur">
        {{ group.title }} <span class="font-mono text-xs font-normal text-faint">{{ group.items.length }}</span>
      </h2>
      <div
          v-for="s in group.items"
          :key="s.id"
          data-nav
          tabindex="0"
          role="button"
          class="group flex min-h-12 cursor-pointer items-center gap-3 border-b border-line/60 px-4 py-2 text-sm outline-none transition-colors hover:bg-hover focus-visible:bg-active"
          :class="!s.enabled && 'opacity-60'"
          @click="edit(s.project, s)"
          @contextmenu="openMenu($event, s)"
      >
        <SectionIcon section="schedules" class="size-4 text-faint" />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-fg">{{ s.title }}</span>
          <span class="truncate text-xs text-faint">
            {{ describe(s) }}<template v-if="s.kind === 'message'"> · messages the sessions</template><template v-else-if="s.ask"> · asks the sessions</template><template v-if="s.kind === 'issue' && s.priority"> · {{ s.priority }}</template>
          </span>
        </div>
        <span v-if="s.runs[0]" class="hidden shrink-0 items-center gap-1 text-xs md:flex" :class="OUTCOME[s.runs[0].outcome]" :title="s.runs[0].note ?? ''">
          <template v-if="s.runs[0].outcome === 'made'">
            ✓ made
            <button type="button" class="font-mono hover:underline" @click.stop="openIssue(s.project, s.runs[0].issue!)">{{ s.runs[0].issue }}</button>
          </template>
          <template v-else>{{ {sent: '✉ sent', skipped: '⤼ skipped', failed: '✗ failed'}[s.runs[0].outcome] }}</template>
          <span class="text-faint">· {{ ago(s.runs[0].at) }}</span>
        </span>
        <button
            v-if="!ran(s)"
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-md text-xs text-muted transition-opacity hover:bg-active hover:text-fg focus-visible:opacity-100 disabled:opacity-40"
            :class="s.enabled && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'"
            :disabled="pausing.has(s.id)"
            :title="s.enabled ? 'Pause' : 'Resume'"
            :aria-label="`${s.enabled ? 'Pause' : 'Resume'} ${s.title}`"
            @click.stop="togglePause(s)"
        >{{ s.enabled ? '❙❙' : '▶' }}</button>
        <span class="w-36 shrink-0 text-right text-xs" :title="s.next_run ? when(s.next_run) : ''">
          <template v-if="s.enabled && s.next_run"><span class="text-fg">{{ until(s.next_run) }}</span> <span class="text-faint">· {{ when(s.next_run).replace(/^\w+ \d+ \w+ /, '') }}</span></template>
          <span v-else class="text-faint">{{ ran(s) ? 'ran' : 'paused' }}</span>
        </span>
      </div>
    </section>
  </div>
</template>
