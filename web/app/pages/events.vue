<script setup lang="ts">
import type {EventLevel, LoggedEvent} from '#shared/roadmap'

// The event log (ORR-322), for looking into a problem, read like a console (ORR-378): a line each, oldest at the top
// and the newest at the bottom, each with the time it happened and coloured by its level. What went wrong (a 5xx, an
// error in the page, a schedule or backup that failed) and, while Advanced is on, what orrery did (sessions and
// launchers, schedule runs, backups, migrations, starts) and each change to the roadmap (issues, comments, chunks, docs,
// releases). Levels can be switched off and kinds hidden (ORR-379), per browser; it keeps to a project (`?project=`)
// and a kind or a family of them (`?kind=`, ORR-401), in the URL so the view can be linked. A line opens to its details, and an
// error can be resolved; the issue ids in it, and its project, link to them (ORR-403). It's there while Advanced is on (App settings
// → This orrery); opening it marks the new errors seen.
useHead({title: 'Events · orrery'})
const route = useRoute()
const router = useRouter()
const {settings} = useAppSettings()
const {ordered} = useProjectOrder()
const {events, loaded, load, seen, resolve} = useLoggedEvents()
const {byId} = useRoadmaps()
const {hidden, levelShown, toggleLevel, hideKind, showKind, shows} = useHiddenEvents()

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
/** A kind's family, when it has one: `issue` for `issue.status`. */
const familyOf = (kind: string) => kind.includes('.') ? kind.split('.')[0] : undefined
const projectOptions = computed(() => [{value: '', label: 'All projects'}, ...ordered.value.map(p => ({value: p.id, label: p.name}))])
const kind = computed({
    get: () => (route.query.kind as string | undefined) ?? '',
    set: k => router.replace({query: {...route.query, kind: k || undefined}}),
})
/** Whether the event is of `kind`: that kind itself, or one in its family (`session` is every `session.*`). */
const ofKind = (event: LoggedEvent, k: string) => !k || event.kind === k || event.kind.startsWith(`${k}.`)
/** Every kind in the log, in the project kept to (and the one asked for), each family first with its kinds under it. */
const kindOptions = computed(() => {
    const kinds = [...new Set([...events.value.filter(e => !only.value || e.project === only.value).map(e => e.kind), ...kind.value ? [kind.value] : []])].sort()
    const families = [...new Set(kinds.map(k => familyOf(k)).filter((f): f is string => !!f))]
    const loose = kinds.filter(k => !familyOf(k) && !families.includes(k))
    return [
        {value: '', label: 'All events'},
        ...[...families, ...loose].sort().flatMap(f => families.includes(f)
            ? [{value: f, label: `${f}.* (all)`}, ...kinds.filter(k => familyOf(k) === f).map(k => ({value: k, label: k}))]
            : [{value: f, label: f}]),
    ]
})
/** The kind kept to, as it reads: `session.*` for a family. */
const kindLabel = computed(() => kindOptions.value.some(o => o.label === `${kind.value}.* (all)`) ? `${kind.value}.*` : kind.value)
/** Oldest first, as a console reads. */
const inProject = computed(() => events.value.filter(e => (!only.value || e.project === only.value) && ofKind(e, kind.value)))
const shown = computed(() => inProject.value.filter(shows).toReversed())
/** How many the filters keep out, to say so when none are left. */
const filteredAway = computed(() => inProject.value.length - shown.value.length)
const LEVELS: EventLevel[] = ['error', 'warn', 'info']

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
/** The message in pieces, each of the project's issue ids in it (`ORR-12`) a link to that issue, but a deleted one's:
 * the line's own subject and any other it names, so `claude moved ORR-12` opens ORR-12. */
function messageParts(event: LoggedEvent): {text: string, to?: string}[] {
    const key = event.project ? byId(event.project)?.key : undefined
    if (!key || !event.project) return [{text: event.message}]
    const gone = event.kind === 'issue.deleted' ? event.subject : undefined
    const parts: {text: string, to?: string}[] = []
    let at = 0
    for (const found of event.message.matchAll(new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\b`, 'g'))) {
        if (found[0] === gone) continue
        if (found.index > at) parts.push({text: event.message.slice(at, found.index)})
        parts.push({text: found[0], to: `/p/${event.project}/issues/${found[0]}`})
        at = found.index + found[0].length
    }
    if (at < event.message.length) parts.push({text: event.message.slice(at)})
    return parts
}
const toggle = (event: LoggedEvent) => {
    open.value = open.value === event.id ? null : event.id
}
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
    <PropertyPicker v-model="kind" :options="kindOptions" label="Kind" field small>
      <span class="truncate" :class="kind && 'font-mono text-[12px]'">{{ kind ? kindLabel : 'All events' }}</span>
    </PropertyPicker>
    <template #end>
      <div class="flex min-w-0 flex-wrap items-center justify-end gap-1">
        <button
            v-for="gone in hidden.kinds"
            :key="gone"
            type="button"
            class="inline-flex h-6 items-center gap-1 rounded-md bg-well px-2 font-mono text-[11px] text-muted ring-1 ring-line hover:text-fg"
            :title="`Show ${gone} again`"
            @click="showKind(gone)"
        >
          <span class="line-through">{{ gone }}</span><span aria-hidden="true">×</span>
        </button>
      </div>
      <div class="flex shrink-0 items-center gap-1" role="group" aria-label="Levels">
        <button
            v-for="level in LEVELS"
            :key="level"
            type="button"
            class="h-6 rounded-md px-2 font-mono text-[11px] font-semibold ring-1"
            :class="levelShown(level) ? [LEVEL[level].text, 'ring-line'] : 'text-faint line-through ring-transparent'"
            :aria-pressed="levelShown(level)"
            :title="levelShown(level) ? `Hide ${level} lines` : `Show ${level} lines`"
            @click="toggleLevel(level)"
        >
          {{ LEVEL[level].label }}
        </button>
      </div>
    </template>
  </ViewToolbar>

  <div v-if="!settings.advanced" class="px-4 pt-3">
    <p class="rounded-lg bg-well px-3 py-2 text-xs text-muted ring-1 ring-line">
      Advanced is off, so only errors are recorded. Turn it on in
      <NuxtLink to="/settings?tab=orrery#advanced" class="underline underline-offset-2 hover:text-fg">App settings</NuxtLink>
      to record what orrery does and each change to the roadmap as well.
    </p>
  </div>
  <p v-if="failed" class="px-4 pt-3 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>

  <div class="relative min-h-0 flex-1">
    <div ref="scroller" class="absolute inset-0 overflow-auto py-2 font-mono text-xs leading-5" @scroll="onScroll">
      <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center font-sans">
        <p v-if="filteredAway" class="text-sm text-muted">{{ filteredAway }} line{{ filteredAway === 1 ? '' : 's' }} hidden by the filters above.</p>
        <p v-else class="text-sm text-muted">Nothing logged{{ kind ? ` of ${kindLabel}` : '' }}{{ only ? ` in ${projectName(only)}` : '' }} yet.</p>
        <p v-if="!filteredAway" class="text-xs text-faint">Errors in the server and the page land here, and while Advanced is on, what orrery does and each change to the roadmap, a line each. Nothing leaves this machine.</p>
      </div>
      <div v-for="event in shown" :key="event.id" :class="event.resolved_at ? 'opacity-50' : ''">
        <!-- A div with the toggle, not a button: the links in it can't go in a button. -->
        <div
            role="button"
            tabindex="0"
            class="flex w-full min-w-max cursor-pointer items-baseline gap-3 px-4 text-left whitespace-pre focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
            :class="LEVEL[event.level].line"
            :aria-expanded="open === event.id"
            @click="toggle(event)"
            @keydown.enter.self.prevent="toggle(event)"
            @keydown.space.self.prevent="toggle(event)"
        >
          <span class="text-faint">{{ stamp(event.first_seen) }}</span>
          <span class="w-10 shrink-0 font-semibold" :class="LEVEL[event.level].text">{{ LEVEL[event.level].label }}</span>
          <span class="text-muted">{{ event.kind }}</span>
          <NuxtLink v-if="event.project" :to="`/p/${event.project}`" class="text-faint hover:text-fg hover:underline" @click.stop>[{{ event.project }}]</NuxtLink>
          <span :class="event.level === 'info' ? 'text-fg' : LEVEL[event.level].text"><template v-for="(part, i) in messageParts(event)" :key="i"><NuxtLink
              v-if="part.to"
              :to="part.to"
              class="text-accent-600 hover:underline dark:text-accent-400"
              @click.stop
          >{{ part.text }}</NuxtLink><template v-else>{{ part.text }}</template></template></span>
          <span v-if="event.count > 1" class="text-faint">×{{ event.count }}</span>
          <span v-if="event.resolved_at" class="text-faint">(resolved)</span>
        </div>
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
            <UiButton class="ml-auto" size="xs" variant="ghost" @click="hideKind(event.kind)">Hide {{ event.kind }}</UiButton>
            <UiButton v-if="familyOf(event.kind)" size="xs" variant="ghost" @click="hideKind(familyOf(event.kind)!)">Hide all {{ familyOf(event.kind) }}</UiButton>
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
