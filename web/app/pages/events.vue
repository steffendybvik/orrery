<script setup lang="ts">
import type {EventLevel, LoggedEvent} from '#shared/roadmap'

// The event log (ORR-322), for looking into a problem, read like a console (ORR-378): a line each, oldest at the top
// and the newest at the bottom, each with the time it happened and coloured by its level. What went wrong (a 5xx, an
// error in the page, a schedule or backup that failed) and, while Advanced is on, what Orrery did (sessions and
// launchers, schedule runs, backups, migrations, starts) and each change to the roadmap (issues, comments, chunks, docs,
// releases). A line opens to its details, and an error can be resolved. It's there while Advanced is on (App settings
// → This Orrery); opening it marks the new errors seen.
useHead({title: 'Events · Orrery'})
const route = useRoute()
const router = useRouter()
const {settings} = useAppSettings()
const {ordered} = useProjectOrder()
const {events, loaded, load, seen, resolve} = useLoggedEvents()
const {byId} = useRoadmaps()

const scroller = ref<HTMLElement | null>(null)
/** Whether it's scrolled to the bottom, so a new line keeps it there, as a console does. */
const following = ref(true)
function onScroll() {
    const el = scroller.value
    if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}
async function toBottom() {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
    following.value = true
}

onMounted(async () => {
    await load()
    seen()
    toBottom()
})
// Those arriving while it's open are seen too, and followed when it's at the bottom.
watch(events, () => {
    seen()
    if (following.value) toBottom()
})

const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: {...route.query, project: id || undefined}}),
})
const projectOptions = computed(() => [{value: '', label: 'All projects'}, ...ordered.value.map(p => ({value: p.id, label: p.name}))])
/** Oldest first, as a console reads. */
const shown = computed(() => events.value.filter(e => !only.value || e.project === only.value).toReversed())

const open = ref<number | null>(null)
const failed = ref('')
async function resolveIt(event: LoggedEvent) {
    failed.value = ''
    try {
        await resolve(event.id)
    } catch (error) {
        failed.value = errorMessage(error)
    }
}

const LEVEL = {
    error: {label: 'ERROR', line: 'bg-rose-500/10 hover:bg-rose-500/15', text: 'text-rose-600 dark:text-rose-400'},
    warn: {label: 'WARN', line: 'bg-amber-500/10 hover:bg-amber-500/15', text: 'text-amber-700 dark:text-amber-300'},
    info: {label: 'INFO', line: 'hover:bg-hover', text: 'text-sky-600 dark:text-sky-400'},
} satisfies Record<EventLevel, {label: string, line: string, text: string}>
const pad = (n: number, width = 2) => String(n).padStart(width, '0')
/** When it happened, to the millisecond, in local time: `2026-10-28 11:31:34.600`. */
function stamp(iso: string) {
    const d = new Date(iso)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}
const projectName = (id: string) => byId(id)?.name ?? id
/** An issue it's about that's still there, to open. */
const issueLink = (event: LoggedEvent) => event.subject && event.project && event.kind.startsWith('issue.') && event.kind !== 'issue.deleted'
    ? `/p/${event.project}/issues/${event.subject}` : undefined
/** Its details, but the stack, which shows on its own. */
const rest = (event: LoggedEvent) => Object.fromEntries(Object.entries(event.details ?? {}).filter(([k]) => k !== 'stack'))
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="16" r="3" /></svg>
    <h1 class="truncate text-sm font-medium">Events</h1>
  </PageHeader>

  <ViewToolbar>
    <PropertyPicker v-model="only" :options="projectOptions" label="Project" field small>
      <span class="truncate">{{ projectOptions.find(o => o.value === only)?.label ?? only }}</span>
    </PropertyPicker>
  </ViewToolbar>

  <div v-if="!settings.advanced" class="px-4 pt-3">
    <p class="rounded-lg bg-well px-3 py-2 text-xs text-muted ring-1 ring-line">
      Advanced is off, so only errors are recorded. Turn it on in
      <NuxtLink to="/settings?tab=orrery#advanced" class="underline underline-offset-2 hover:text-fg">App settings</NuxtLink>
      to record what Orrery does and each change to the roadmap as well.
    </p>
  </div>
  <p v-if="failed" class="px-4 pt-3 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>

  <div class="relative min-h-0 flex-1">
    <div ref="scroller" class="absolute inset-0 overflow-auto py-2 font-mono text-xs leading-5" @scroll="onScroll">
      <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center font-sans">
        <p class="text-sm text-muted">Nothing logged{{ only ? ` in ${projectName(only)}` : '' }} yet.</p>
        <p class="text-xs text-faint">Errors in the server and the page land here, and while Advanced is on, what Orrery does and each change to the roadmap, a line each. Nothing leaves this machine.</p>
      </div>
      <div v-for="event in shown" :key="event.id" :class="event.resolved_at ? 'opacity-50' : ''">
        <button
            type="button"
            class="flex w-full min-w-max items-baseline gap-3 px-4 text-left whitespace-pre"
            :class="LEVEL[event.level].line"
            :aria-expanded="open === event.id"
            @click="open = open === event.id ? null : event.id"
        >
          <span class="text-faint">{{ stamp(event.first_seen) }}</span>
          <span class="w-10 shrink-0 font-semibold" :class="LEVEL[event.level].text">{{ LEVEL[event.level].label }}</span>
          <span class="text-muted">{{ event.kind }}</span>
          <span v-if="event.project" class="text-faint">[{{ event.project }}]</span>
          <span :class="event.level === 'info' ? 'text-fg' : LEVEL[event.level].text">{{ event.message }}</span>
          <span v-if="event.count > 1" class="text-faint">×{{ event.count }}</span>
          <span v-if="event.resolved_at" class="text-faint">(resolved)</span>
        </button>
        <div v-if="open === event.id" class="flex flex-col gap-2 border-l-2 border-line py-2 pr-4 pl-6 ml-4 text-[11px]">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4">
            <dt class="text-faint">id</dt><dd class="text-fg">#{{ event.id }}</dd>
            <template v-if="event.subject">
              <dt class="text-faint">subject</dt>
              <dd><NuxtLink v-if="issueLink(event)" :to="issueLink(event)" class="text-accent-600 hover:underline dark:text-accent-400">{{ event.subject }}</NuxtLink><span v-else class="text-fg">{{ event.subject }}</span></dd>
            </template>
            <template v-if="event.count > 1"><dt class="text-faint">last seen</dt><dd class="text-fg">{{ stamp(event.last_seen) }} ({{ event.count }} times)</dd></template>
            <template v-for="(value, key) in rest(event)" :key="key">
              <dt class="text-faint">{{ key }}</dt>
              <dd class="min-w-0 break-words text-fg">{{ typeof value === 'string' ? value : JSON.stringify(value) }}</dd>
            </template>
          </dl>
          <pre v-if="typeof event.details?.stack === 'string'" class="max-h-64 overflow-auto whitespace-pre text-muted">{{ event.details.stack }}</pre>
          <div class="flex items-center gap-2 font-sans">
            <UiButton v-if="event.level !== 'info' && !event.resolved_at" size="xs" variant="success-outline" @click="resolveIt(event)">Resolve</UiButton>
            <CopyButton :text="JSON.stringify(event, null, 2)" />
            <span class="text-faint">Copy it to an issue for an agent to look into.</span>
          </div>
        </div>
      </div>
    </div>
    <button
        v-if="!following"
        type="button"
        class="absolute right-4 bottom-4 rounded-full bg-panel px-3 py-1 text-xs text-muted shadow ring-1 ring-line hover:text-fg"
        @click="toBottom"
    >
      Newest ↓
    </button>
  </div>
</template>
