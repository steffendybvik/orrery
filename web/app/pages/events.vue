<script setup lang="ts">
import type {EventLevel, LoggedEvent} from '#shared/roadmap'

// The event log (ORR-322), for looking into a problem: what went wrong (a 5xx, an error in the page, a schedule or
// backup that failed) and, while Advanced is on, what Orrery did (sessions and launchers, schedule runs, backups,
// migrations, starts). Newest first, by level and project; a row opens to its details, and an error can be resolved.
// It's there while Advanced is on (App settings → This Orrery); opening it marks the new errors seen.
useHead({title: 'Events · Orrery'})
const route = useRoute()
const router = useRouter()
const {settings} = useAppSettings()
const {ordered} = useProjectOrder()
const {events, loaded, load, seen, resolve} = useLoggedEvents()
const {byId} = useRoadmaps()

onMounted(() => {
    load()
    seen()
})
// Those arriving while it's open are seen too.
watch(events, () => seen())

type Show = 'all' | EventLevel
const show = computed<Show>({
    get: () => (['error', 'warn', 'info'] as const).find(l => l === route.query.level) ?? 'all',
    set: level => router.replace({query: {...route.query, level: level === 'all' ? undefined : level}}),
})
const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: {...route.query, project: id || undefined}}),
})
const projectOptions = computed(() => [{value: '', label: 'All projects'}, ...ordered.value.map(p => ({value: p.id, label: p.name}))])
const shown = computed(() => events.value.filter(e => (show.value === 'all' || e.level === show.value) && (!only.value || e.project === only.value)))
const count = (level: EventLevel) => events.value.filter(e => e.level === level && !e.resolved_at && (!only.value || e.project === only.value)).length
const options = computed(() => [
    {value: 'all' as const, label: 'All'},
    {value: 'error' as const, label: `Errors ${count('error') || ''}`.trim()},
    {value: 'warn' as const, label: `Warnings ${count('warn') || ''}`.trim()},
    {value: 'info' as const, label: 'Info'},
])

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
    error: {label: 'Error', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400'},
    warn: {label: 'Warning', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300'},
    info: {label: 'Info', dot: 'bg-faint/60', text: 'text-muted'},
} satisfies Record<EventLevel, {label: string, dot: string, text: string}>
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'medium'})
const projectName = (id: string) => byId(id)?.name ?? id
/** Its details, but the stack, which shows on its own. */
const rest = (event: LoggedEvent) => Object.fromEntries(Object.entries(event.details ?? {}).filter(([k]) => k !== 'stack'))
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="16" r="3" /></svg>
    <h1 class="truncate text-sm font-medium">Events</h1>
  </PageHeader>

  <ViewToolbar>
    <SegmentedControl v-model="show" :options="options" />
    <PropertyPicker v-model="only" :options="projectOptions" label="Project" field small>
      <span class="truncate">{{ projectOptions.find(o => o.value === only)?.label ?? only }}</span>
    </PropertyPicker>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="!settings.advanced" class="mx-auto max-w-3xl px-4 pt-4">
      <p class="rounded-lg bg-well px-3 py-2 text-xs text-muted ring-1 ring-line">
        Advanced is off, so only errors are recorded. Turn it on in
        <NuxtLink to="/settings?tab=orrery#advanced" class="underline underline-offset-2 hover:text-fg">App settings</NuxtLink>
        to record what Orrery does as well.
      </p>
    </div>
    <p v-if="failed" class="mx-auto max-w-3xl px-4 pt-3 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
    <ul class="mx-auto flex max-w-3xl flex-col px-3 py-4 sm:px-4">
      <li v-for="event in shown" :key="event.id" class="border-b border-line last:border-b-0">
        <button
            type="button"
            class="flex w-full items-start gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-hover"
            :class="event.resolved_at ? 'opacity-60' : ''"
            :aria-expanded="open === event.id"
            @click="open = open === event.id ? null : event.id"
        >
          <span class="mt-1.5 size-2 shrink-0 rounded-full" :class="LEVEL[event.level].dot" :title="LEVEL[event.level].label" />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <span class="min-w-0 break-words text-fg">{{ event.message }}</span>
              <span v-if="event.count > 1" class="rounded-full bg-well px-1.5 font-mono text-[10px] text-muted ring-1 ring-line tabular-nums" :title="`${event.count} times since ${when(event.first_seen)}`">×{{ event.count }}</span>
            </span>
            <span class="flex flex-wrap items-center gap-x-2 text-xs text-faint">
              <span class="font-mono" :class="LEVEL[event.level].text">{{ event.kind }}</span>
              <span v-if="event.project">in {{ projectName(event.project) }}</span>
              <span v-if="event.resolved_at">· resolved</span>
            </span>
          </span>
          <span class="shrink-0 text-xs text-faint" :title="when(event.last_seen)">{{ ago(event.last_seen) }}</span>
        </button>
        <div v-if="open === event.id" class="mb-3 ml-7 flex flex-col gap-2 rounded-lg bg-well p-3 text-xs ring-1 ring-line">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt class="text-muted">First seen</dt><dd class="text-fg">{{ when(event.first_seen) }}</dd>
            <template v-if="event.count > 1"><dt class="text-muted">Last seen</dt><dd class="text-fg">{{ when(event.last_seen) }} ({{ event.count }} times)</dd></template>
            <template v-for="(value, key) in rest(event)" :key="key">
              <dt class="text-muted">{{ key }}</dt>
              <dd class="min-w-0 break-words font-mono text-fg">{{ typeof value === 'string' ? value : JSON.stringify(value) }}</dd>
            </template>
          </dl>
          <pre v-if="typeof event.details?.stack === 'string'" class="max-h-64 overflow-auto rounded-md bg-panel p-2 font-mono text-[11px] leading-5 whitespace-pre text-muted ring-1 ring-line">{{ event.details.stack }}</pre>
          <div class="flex items-center gap-2">
            <UiButton v-if="event.level !== 'info' && !event.resolved_at" size="xs" variant="success-outline" @click="resolveIt(event)">Resolve</UiButton>
            <CopyButton :text="JSON.stringify(event, null, 2)" />
            <span class="text-faint">Copy it to an issue for an agent to look into.</span>
          </div>
        </div>
      </li>
    </ul>
    <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
      <p class="text-sm text-muted">{{ show === 'error' ? 'No errors' : 'Nothing logged' }}{{ only ? ` in ${projectName(only)}` : '' }} yet.</p>
      <p class="text-xs text-faint">Errors in the server and the page land here, and while Advanced is on, what Orrery does: sessions starting and stopping, launchers, schedule runs, backups and migrations. Nothing leaves this machine.</p>
    </div>
  </div>
</template>
