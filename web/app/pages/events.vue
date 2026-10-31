<script setup lang="ts">
import type {EventLevel, LoggedEvent} from '#shared/roadmap'

// The event log (ORR-322), for looking into a problem, read like a console (ORR-378): a line each, oldest at the top
// and the newest at the bottom, each with the time it happened and coloured by its level. What went wrong (a 5xx, an
// error in the page, a schedule or backup that failed) and, while Advanced is on, what orrery did (sessions and
// launchers, schedule runs, backups, migrations, starts) and each change to the roadmap (issues, comments, chunks, docs,
// releases). Levels can be switched off (ORR-379), per browser; it keeps to a project (`?project=`) and a kind or a
// family of them (`?kind=`, ORR-401), in the URL so the view can be linked. A line is only ever a line, as in a console
// (ORR-472): the issue ids in it, and its project, link to them (ORR-403). It's in the sidebar while Advanced is on
// (ORR-578), and on App settings → Advanced (ORR-561); opening it marks the new errors seen.
useHead({title: 'Events · orrery'})
const route = useRoute()
const router = useRouter()
const {settings} = useAppSettings()
const {ordered} = useProjectOrder()
const {events, loaded, load, seen} = useLoggedEvents()
const {byId} = useRoadmaps()
const {who} = useOwner()
const {levelShown, toggleLevel, shows} = useHiddenEvents()

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

const LEVEL = {
    error: {label: 'ERROR', line: 'bg-rose-500/10 hover:bg-rose-500/15', text: 'text-rose-700 dark:text-rose-400'},
    warn: {label: 'WARN', line: 'bg-amber-500/10 hover:bg-amber-500/15', text: 'text-amber-800 dark:text-amber-300'},
    info: {label: 'INFO', line: 'hover:bg-hover', text: 'text-sky-700 dark:text-sky-400'},
} satisfies Record<EventLevel, {label: string, line: string, text: string}>
const pad = (n: number, width = 2) => String(n).padStart(width, '0')
/** When it happened, to the millisecond, in local time: `2026-10-28 11:31:34.600`. */
function stamp(iso: string) {
    const d = new Date(iso)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}
const projectName = (id: string) => byId(id)?.name ?? id
/** The message as the page says it: a roadmap change's line starts with who made it as stored (`claude moved ORR-12`),
 * shown as `who()` names them (`Agent moved ORR-12`). */
function messageOf(event: LoggedEvent): string {
    const by = event.details?.by
    return typeof by === 'string' && event.message.startsWith(`${by} `) ? `${who(by)}${event.message.slice(by.length)}` : event.message
}
/** The message in pieces, each of the project's issue ids in it (`ORR-12`) a link to that issue, but a deleted one's:
 * the line's own subject and any other it names, so `Agent moved ORR-12` opens ORR-12. */
function messageParts(event: LoggedEvent): {text: string, to?: string}[] {
    const message = messageOf(event)
    const key = event.project ? byId(event.project)?.key : undefined
    if (!key || !event.project) return [{text: message}]
    const gone = event.kind === 'issue.deleted' ? event.subject : undefined
    const parts: {text: string, to?: string}[] = []
    let at = 0
    for (const found of message.matchAll(new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\b`, 'g'))) {
        if (found[0] === gone) continue
        if (found.index > at) parts.push({text: message.slice(at, found.index)})
        parts.push({text: found[0], to: `/p/${event.project}/issues/${found[0]}`})
        at = found.index + found[0].length
    }
    if (at < message.length) parts.push({text: message.slice(at)})
    return parts
}
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
      <NuxtLink to="/settings?tab=advanced" class="underline underline-offset-2 hover:text-fg">App settings</NuxtLink>
      to record what orrery does and each change to the roadmap as well.
    </p>
  </div>

  <div class="relative min-h-0 flex-1">
    <div ref="scroller" role="log" aria-label="Events" class="absolute inset-0 overflow-auto py-2 font-mono text-xs leading-5" @scroll="onScroll">
      <UiLoading v-if="!loaded" class="font-sans" />
      <div v-else-if="!shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center font-sans">
        <p v-if="filteredAway" class="text-sm text-muted">{{ filteredAway }} line{{ filteredAway === 1 ? '' : 's' }} hidden by the filters above.</p>
        <p v-else class="text-sm text-muted">Nothing logged{{ kind ? ` of ${kindLabel}` : '' }}{{ only ? ` in ${projectName(only)}` : '' }} yet.</p>
        <p v-if="!filteredAway" class="text-xs text-faint">Errors in the server and the page land here, and while Advanced is on, what orrery does and each change to the roadmap, a line each. Nothing leaves this machine.</p>
      </div>
      <div
          v-for="event in shown"
          :key="event.id"
          class="flex w-full flex-wrap items-baseline gap-x-3 px-4 whitespace-pre-wrap sm:min-w-max sm:flex-nowrap sm:whitespace-pre"
          :class="event.resolved_at ? 'hover:bg-hover' : LEVEL[event.level].line"
      >
        <span class="text-faint">{{ stamp(event.first_seen) }}</span>
        <span class="w-10 shrink-0 font-semibold" :class="event.resolved_at ? 'text-muted' : LEVEL[event.level].text">{{ LEVEL[event.level].label }}</span>
        <span class="text-muted">{{ event.kind }}</span>
        <NuxtLink v-if="event.project" :to="`/p/${event.project}`" class="text-faint hover:text-fg hover:underline">[{{ event.project }}]</NuxtLink>
        <span class="basis-full break-words sm:basis-auto" :class="event.resolved_at ? 'text-muted' : event.level === 'info' ? 'text-fg' : LEVEL[event.level].text"><template v-for="(part, i) in messageParts(event)" :key="i"><NuxtLink
            v-if="part.to"
            :to="part.to"
            class="text-accent-700 underline underline-offset-2 dark:text-accent-400"
        >{{ part.text }}</NuxtLink><template v-else>{{ part.text }}</template></template></span>
        <span v-if="event.count > 1" class="text-faint">×{{ event.count }}</span>
        <span v-if="event.resolved_at" class="text-faint">(resolved{{ event.resolved_by ? ` by ${who(event.resolved_by)}` : '' }})</span>
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
