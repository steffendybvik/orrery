<script setup lang="ts">
import type {NoticeRow} from '~/composables/useInbox'

// The bell, larger, as a list and a reading pane. The list: what waits on the owner first (it goes when answered, decided or
// cleared; clearing a proposal leaves it pending), then the rest by day as a timeline, one line per issue a day, each saying
// what happened. The list has the page until a line is chosen: that opens its history beside the list (on a narrow window, in
// its place) and marks it read, and choosing it again or closing the pane gives the list the page back. Opening the page only
// resets the bell's count, so the filled dots stay what's still to read.
useHead({title: 'Notifications · orrery'})
const {notices, lists, seen, load, loadChanges, markRead, clear} = useInbox()
const {byId} = useRoadmaps()
const {newErrors} = useLoggedEvents()
const route = useRoute()
const router = useRouter()

onMounted(() => {
    seen()
    load('waiting')
    load('inbox')
})
// Those arriving while it's open count as seen too, for the bell.
watch(notices, () => seen())

const waiting = computed(() => waitingRows(lists.value.waiting.items))
const days = computed(() => noticeDays(lists.value.inbox.items))
const shown = computed(() => [...lists.value.waiting.items, ...lists.value.inbox.items])
const loaded = computed(() => lists.value.inbox.loaded && lists.value.waiting.loaded)
const clearable = computed(() => shown.value.filter(n => !n.cleared))
const anyRead = computed(() => shown.value.some(n => n.read && !isWaiting(n)))
const projectName = (id: string) => byId(id)?.name ?? id
/** A list from one project needn't say so on every line. */
const manyProjects = computed(() => new Set(shown.value.map(n => n.project)).size > 1)

// The status changes on what's listed, from the start of the day of its oldest. Read again as the list changes.
const since = computed(() => {
    const oldest = shown.value.reduce((at, n) => !at || n.created_at < at ? n.created_at : at, '')
    if (!oldest) return ''
    const start = new Date(oldest)
    start.setHours(0, 0, 0, 0)
    return start.toISOString()
})
watch(() => [since.value, shown.value.length] as const, ([from]) => {
    if (from) loadChanges(from)
}, {immediate: true})

// The chosen line, in the address, so Back leaves it on a narrow window, where it takes the list's place.
const selected = computed<NoticeRow | undefined>(() => {
    const key = route.query.open
    return [...waiting.value, ...days.value.flatMap(d => d.rows)].find(r => r.key === key)
})
const narrow = () => !window.matchMedia('(min-width: 1024px)').matches
function choose(row: NoticeRow) {
    if (selected.value?.key === row.key) return back()
    const to = {query: {...route.query, open: row.key}}
    if (narrow()) router.push(to)
    else router.replace(to)
}
function back() {
    const {open: _, ...query} = route.query
    router.replace({query})
}
// It's read once it's on screen, and so is what arrives while it is.
watch(selected, row => {
    if (row) markRead(row.notices)
}, {immediate: true})
const clearLine = (row: NoticeRow) => clear(row.notices.filter(n => !n.cleared))
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
    <h1 class="truncate text-sm font-medium">Notifications</h1>
  </PageHeader>

  <ViewToolbar>
    <template #end>
      <UiButton v-if="anyRead" variant="ghost" size="xs" title="Clear every read one, not those waiting on you" @click="clear()">Clear read</UiButton>
      <UiButton v-if="clearable.length" variant="ghost" size="xs" :title="`Clear these ${clearable.length}; a proposal stays pending on its issue`" @click="clear(clearable)">Clear all</UiButton>
    </template>
  </ViewToolbar>

  <NuxtLink v-if="newErrors.length" to="/events?level=error" class="m-3 flex shrink-0 items-center gap-2 rounded-xl bg-panel px-4 py-2.5 text-[13px] ring-1 ring-rose-500/40 transition-colors hover:tint">
    <span class="size-2 shrink-0 rounded-full bg-rose-500" />
    <span class="flex-1 text-fg">{{ newErrors.length }} new kind{{ newErrors.length === 1 ? '' : 's' }} of error: <span class="text-muted">{{ newErrors[0]?.message }}</span></span>
    <span class="shrink-0 text-xs text-faint">Events →</span>
  </NuxtLink>

  <div v-if="loaded && !shown.length" class="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-4 py-24 text-center">
    <p class="text-sm text-muted">No notifications.</p>
    <p class="text-xs text-faint">Agents' comments on issues land here and in the bell; their questions and proposals for you stay, marked in violet, until you answer or decide them on the issue, or clear them.</p>
  </div>

  <div v-else class="flex min-h-0 flex-1">
    <div class="min-w-0 flex-1 overflow-y-auto border-line" :class="{'hidden lg:block lg:w-[26rem] lg:flex-none lg:border-r': selected}">
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
    <div v-if="selected" class="min-w-0 flex-1 overflow-y-auto">
      <NoticeHistory :key="selected.key" :row="selected" :project="projectName(selected.project)" @back="back" />
    </div>
  </div>
</template>
