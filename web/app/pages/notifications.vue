<script setup lang="ts">
import type {NoticeRow} from '~/composables/useInbox'

// The bell, larger, as a list and a reading pane. The list: what waits on the owner first (it goes when answered, decided or
// cleared; clearing a proposal leaves it pending), then the rest by day as a timeline, one line per issue a day, each saying
// what happened. On a wide window the page opens with the first line's history beside the list (ORR-990), and choosing a line
// shows its history there instead; either way the line shown is marked read. Choosing it again or closing the pane gives the
// list the page back, remembered in this browser until a line is chosen again. On a narrow window the list has the page, and a
// chosen line takes its place, so Back returns to the list. Dragging the border between them resizes the list. Opening the page
// otherwise only resets the bell's count, so the filled dots stay what's still to read. With notices from more than one project, a picker
// keeps the page to one of them (`?project=`, ORR-822), and its Clear buttons to what that leaves shown.
useHead({title: 'Notifications · orrery'})
const {notices, lists, seen, load, loadChanges, markRead, clear} = useInbox()
const {byId} = useRoadmaps()
const {newErrors} = useLoggedEvents()
const route = useRoute()
const router = useRouter()

function loadLists() {
    load('waiting')
    load('inbox')
}
onMounted(() => {
    seen()
    loadLists()
})
// Those arriving while it's open count as seen too, for the bell.
watch(notices, () => seen())

const projectName = (id: string) => byId(id)?.name ?? id
const listed = computed(() => [...lists.value.waiting.items, ...lists.value.inbox.items])
/** The project the page keeps to, or '' for all of them. */
const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: {...route.query, project: id || undefined}}),
})
const inOnly = (n: {project: string}) => !only.value || n.project === only.value
/** The projects with notices listed, and the one kept to even if it has none now. */
const noticeProjects = computed(() => [...new Set([...listed.value.map(n => n.project), ...only.value ? [only.value] : []])]
    .sort((a, b) => projectName(a).localeCompare(projectName(b))))
const projectOptions = computed(() => [{value: '', label: 'All projects'}, ...noticeProjects.value.map(id => ({value: id, label: projectName(id)}))])
const waiting = computed(() => waitingRows(lists.value.waiting.items.filter(inOnly)))
const days = computed(() => noticeDays(lists.value.inbox.items.filter(inOnly)))
const shown = computed(() => listed.value.filter(inOnly))
const loaded = computed(() => lists.value.inbox.loaded && lists.value.waiting.loaded)
/** Why a list the page waits on couldn't be read, so it says so rather than spinning (ORR-854). */
const failed = computed(() => [lists.value.waiting, lists.value.inbox].find(l => !l.loaded && l.failed)?.failed ?? '')
function retry() {
    for (const list of [lists.value.waiting, lists.value.inbox]) list.failed = undefined
    loadLists()
}
const clearable = computed(() => shown.value.filter(n => !n.cleared))
const readShown = computed(() => shown.value.filter(n => n.read && !isWaiting(n) && !n.cleared))
const anyRead = computed(() => readShown.value.length > 0)
// All projects clears every read one on the server, loaded or not; one project only those it shows.
const clearRead = () => only.value ? clear(readShown.value) : clear()
/** A list from one project needn't say so on every line. */
const manyProjects = computed(() => new Set(shown.value.map(n => n.project)).size > 1)

// The status changes on what's listed, from the start of the day of its oldest. Read again as the list changes.
const since = computed(() => {
    const oldest = listed.value.reduce((at, n) => !at || n.created_at < at ? n.created_at : at, '')
    if (!oldest) return ''
    const start = new Date(oldest)
    start.setHours(0, 0, 0, 0)
    return start.toISOString()
})
watch(() => [since.value, listed.value.length] as const, ([from]) => {
    if (from) loadChanges(from)
}, {immediate: true})

/** At Tailwind's lg (1024px) and up the pane sits beside the list. Set on mount, so the server draws the list alone. */
const wide = ref(false)
let wideQuery: MediaQueryList | undefined
const trackWide = () => wide.value = !!wideQuery?.matches
onMounted(() => {
    wideQuery = matchMedia('(min-width: 1024px)')
    trackWide()
    wideQuery.addEventListener('change', trackWide)
})
onBeforeUnmount(() => wideQuery?.removeEventListener('change', trackWide))
/** The owner closed the pane on a wide window: it stays closed, here and on later visits, until a line is chosen. */
const CLOSED_KEY = 'orrery-notifications-pane'
const paneClosed = ref(false)
onMounted(() => {
    try {
        paneClosed.value = localStorage.getItem(CLOSED_KEY) === 'closed'
    } catch {
        // Private windows may refuse: it opens.
    }
})
watch(paneClosed, closed => {
    try {
        if (closed) localStorage.setItem(CLOSED_KEY, 'closed')
        else localStorage.removeItem(CLOSED_KEY)
    } catch {
        // Still holds until a reload.
    }
})
const rows = computed(() => [...waiting.value, ...days.value.flatMap(d => d.rows)])
// The chosen line, in the address, so Back leaves it on a narrow window, where it takes the list's place. With none chosen,
// a wide window shows the first line, unless the pane was closed.
const selected = computed<NoticeRow | undefined>(() => {
    const key = route.query.open
    if (key) return rows.value.find(r => r.key === key)
    return wide.value && !paneClosed.value ? rows.value[0] : undefined
})
function choose(row: NoticeRow) {
    if (selected.value?.key === row.key) return back()
    const to = {query: {...route.query, open: row.key}}
    // Reopened once the address names the line, or the first line would show (and be read) in between.
    ;(wide.value ? router.replace(to) : router.push(to)).then(() => paneClosed.value = false)
}
function back() {
    if (wide.value) paneClosed.value = true
    const {open: _, ...query} = route.query
    router.replace({query})
}
// It's read once it's on screen, and so is what arrives while it is.
watch(selected, row => {
    if (row) markRead(row.notices)
}, {immediate: true})
const clearLine = (row: NoticeRow) => clear(row.notices.filter(n => !n.cleared))
// How wide the list is beside an open line, dragged on the border between them and remembered (ORR-820).
const {width: listWidth, initial: initialListWidth} = usePaneWidth('orrery-notifications-list-width', 416)
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
    <h1 class="truncate text-sm font-medium">Notifications</h1>
  </PageHeader>

  <ViewToolbar>
    <PropertyPicker v-if="noticeProjects.length > 1" v-model="only" :options="projectOptions" label="Project" field small>
      <span class="truncate">{{ projectOptions.find(o => o.value === only)?.label ?? only }}</span>
    </PropertyPicker>
    <template #end>
      <UiButton v-if="anyRead" variant="ghost" size="xs" :title="only ? `Clear the read ones in ${projectName(only)}, not those waiting on you` : 'Clear every read one, not those waiting on you'" @click="clearRead()">Clear read</UiButton>
      <UiButton v-if="clearable.length" variant="ghost" size="xs" :title="`Clear these ${clearable.length}; a proposal stays pending on its issue`" @click="clear(clearable)">Clear all</UiButton>
    </template>
  </ViewToolbar>

  <NuxtLink v-if="newErrors.length" to="/events?level=error" class="m-3 flex shrink-0 items-center gap-2 rounded-xl bg-panel px-4 py-2.5 text-[13px] ring-1 ring-rose-500/40 transition-colors hover:tint">
    <svg class="size-4 shrink-0 text-rose-700 dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4M12 17h.01" /></svg>
    <span class="flex-1 text-fg">{{ newErrors.length }} new kind{{ newErrors.length === 1 ? '' : 's' }} of error: <span class="text-muted">{{ newErrors[0]?.message }}</span></span>
    <span class="shrink-0 text-xs text-faint">Events →</span>
  </NuxtLink>

  <UiLoading v-if="!loaded" :failed="failed" what="the notifications" @retry="retry" />
  <div v-else-if="!shown.length && only && listed.length" class="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-4 py-24 text-center">
    <p class="text-sm text-muted">No notifications in {{ projectName(only) }}.</p>
    <UiButton variant="ghost" size="xs" @click="only = ''">Show all projects</UiButton>
  </div>
  <div v-else-if="!shown.length" class="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-4 py-24 text-center">
    <p class="text-sm text-muted">No notifications.</p>
    <p class="text-xs text-faint">What agents say to you lands here and in the bell: their questions, what's on your issues, answers to you, mentions of you, and an issue shipping. Questions and proposals stay, marked in violet, until you answer or decide them on the issue, or clear them.</p>
  </div>

  <div v-else class="flex min-h-0 flex-1">
    <div
        class="clear-agent min-w-0 flex-1 overflow-y-auto"
        :class="{'hidden lg:block lg:w-[var(--pane-width)] lg:max-w-[calc(100%-20rem)] lg:min-w-60 lg:flex-none': selected}"
        :style="{'--pane-width': `${listWidth}px`}"
    >
      <section v-if="waiting.length" aria-label="Waiting on you">
        <h2 class="sticky top-0 z-20 flex items-baseline gap-2 border-b-2 border-faint/40 bg-canvas px-3 py-1.5 text-[11px] font-semibold tracking-wide text-violet-700 uppercase dark:text-violet-300">
          Waiting on you
          <span class="text-xs font-normal tracking-normal text-muted normal-case">{{ waiting.length }}</span>
        </h2>
        <ul>
          <NoticeLine
              v-for="row in waiting"
              :key="row.key"
              :row="row"
              :selected="selected?.key === row.key"
              :project="manyProjects ? projectName(row.project) : undefined"
              @select="choose(row)"
              @clear="clearLine(row)"
          />
        </ul>
      </section>
      <section v-for="day in days" :key="day.key">
        <h2 class="sticky top-0 z-20 flex items-baseline gap-2 border-y-2 border-faint/40 bg-canvas px-3 py-1.5 text-[13px] font-semibold text-fg">
          {{ day.label }}
          <span class="text-xs font-normal text-muted">{{ day.total }}</span>
          <span v-if="day.unread" class="text-xs font-normal text-muted">· {{ day.unread }} unread</span>
        </h2>
        <ul>
          <NoticeLine
              v-for="row in day.rows"
              :key="row.key"
              :row="row"
              :selected="selected?.key === row.key"
              :project="manyProjects ? projectName(row.project) : undefined"
              @select="choose(row)"
              @clear="clearLine(row)"
          />
        </ul>
      </section>
      <div v-if="lists.inbox.more" class="flex justify-center py-6">
        <UiButton @click="load('inbox', true)">Show older</UiButton>
      </div>
    </div>
    <UiSplitter v-if="selected" v-model="listWidth" :initial="initialListWidth" :min="240" :keep="320" label="Resize the list" class="hidden lg:block" />
    <div v-if="selected" class="clear-agent min-w-0 flex-1 overflow-y-auto">
      <NoticeHistory :key="selected.key" :row="selected" :project="projectName(selected.project)" @back="back" />
    </div>
  </div>
</template>
