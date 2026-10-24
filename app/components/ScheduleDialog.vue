<script setup lang="ts">
import type {Place, Priority, Schedule} from '#shared/roadmap'
import {PLACES, PRIORITIES} from '#shared/roadmap'
import type {Repeat} from '~/utils/schedule'

// Writing a schedule, or changing one, as the owner: in a project, whether each run makes an issue or
// only sends a message to the project's Claude sessions, what it says, when it runs (presets, or a cron
// under Advanced) with its next times shown, and for an issue where it starts and whether it asks the
// sessions to pick it up. ⌘↵ saves, Esc closes.
const {editing} = useSchedules()
const {byId} = useRoadmaps()
const {load} = useOwner()

const KINDS: {value: Repeat['kind'], label: string}[] = [
    {value: 'daily', label: 'Every day'}, {value: 'weekdays', label: 'Weekdays'}, {value: 'weekly', label: 'Some days of the week'},
    {value: 'monthly', label: 'Monthly'}, {value: 'minutes', label: 'Every N minutes'}, {value: 'hours', label: 'Every N hours'},
    {value: 'once', label: 'Once'}, {value: 'cron', label: 'Advanced (cron)'},
]
const PLACE_LABEL: Record<Place, string> = {backlog: 'Backlog', later: 'Later', next: 'Next', now: 'Now', doing: 'Doing'}

const project = ref('')
const sends = ref<'issue' | 'message'>('issue')
const SENDS = [{value: 'issue' as const, label: 'Makes an issue'}, {value: 'message' as const, label: 'Sends a message'}]
const title = ref('')
const notes = ref('')
const kind = ref<Repeat['kind']>('weekdays')
const time = ref('09:00')
const days = ref<number[]>([1])
const day = ref(1)
const every = ref(4)
const everyMinutes = ref(15)
const minute = ref(0)
const once = ref('')
const cron = ref('0 9 * * 1-5')
const timezone = ref(localZone())
const column = ref<Place>('now')
const chunk = ref('')
const priority = ref<Priority | ''>('')
const labels = ref<string[]>([])
const ask = ref(false)
const skipOpen = ref(true)
const saving = ref(false)
const failed = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const existing = computed(() => editing.value?.schedule)
const here = computed(() => byId(project.value))
const chunks = computed(() => here.value?.board.chunks.filter(c => c.id) ?? [])
const known = computed(() => here.value ? [...new Set(allIssues(here.value).flatMap(({issue}) => issue.labels))] : [])

/** A time as `datetime-local` wants it, in this browser's zone. */
const local = (iso: string) => {
    const d = new Date(iso)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

watch(editing, now => {
    if (!now) return
    const s = now.schedule
    project.value = now.project
    sends.value = s?.kind ?? 'issue'
    title.value = s?.title ?? ''
    notes.value = s?.notes ?? ''
    timezone.value = s?.timezone ?? localZone()
    column.value = s?.column ?? 'now'
    chunk.value = s?.chunk ?? ''
    priority.value = s?.priority ?? ''
    labels.value = [...s?.labels ?? []]
    ask.value = s?.ask ?? false
    skipOpen.value = s?.skipOpen ?? true
    const repeat: Repeat = s ? toRepeat(s) : {kind: 'weekdays', time: '09:00'}
    kind.value = repeat.kind
    if ('time' in repeat) time.value = repeat.time
    if (repeat.kind === 'weekly') days.value = [...repeat.days]
    if (repeat.kind === 'monthly') day.value = repeat.day
    if (repeat.kind === 'minutes') everyMinutes.value = repeat.every
    if (repeat.kind === 'hours') {
        every.value = repeat.every
        minute.value = repeat.minute
    }
    once.value = repeat.kind === 'once' ? local(repeat.at) : local(new Date(Date.now() + 3600_000).toISOString())
    cron.value = s?.cron ?? '0 9 * * 1-5'
    failed.value = ''
    nextTick(() => titleInput.value?.focus())
})

const repeat = computed<Repeat>(() => {
    switch (kind.value) {
        case 'weekly': return {kind: 'weekly', time: time.value, days: days.value}
        case 'monthly': return {kind: 'monthly', time: time.value, day: day.value}
        case 'minutes': return {kind: 'minutes', every: everyMinutes.value}
        case 'hours': return {kind: 'hours', every: every.value, minute: minute.value}
        case 'once': return {kind: 'once', at: once.value ? new Date(once.value).toISOString() : ''}
        case 'cron': return {kind: 'cron', cron: cron.value}
        default: return {kind: kind.value, time: time.value}
    }
})
const cronText = computed(() => toCron(repeat.value))
const atText = computed(() => repeat.value.kind === 'once' ? repeat.value.at : null)
const upcoming = computed(() => nextTimes(cronText.value, atText.value, timezone.value))
const ready = computed(() => !!project.value && !!title.value.trim() && (sends.value === 'issue' || !!notes.value.trim())
    && upcoming.value.length > 0 && !saving.value)

function toggleDay(d: number) {
    days.value = days.value.includes(d) ? days.value.filter(x => x !== d) : [...days.value, d]
}

function close() {
    editing.value = null
}

async function save() {
    if (!ready.value) return
    saving.value = true
    failed.value = ''
    const body = {
        kind: sends.value,
        title: title.value.trim(),
        notes: notes.value.trim() || null,
        ...cronText.value ? {cron: cronText.value} : {at: atText.value},
        timezone: timezone.value,
        column: column.value,
        chunk: chunk.value || null,
        priority: priority.value || null,
        labels: labels.value,
        ask: ask.value,
        skipOpen: skipOpen.value,
    }
    try {
        const base = `/api/projects/${encodeURIComponent(project.value)}/schedules`
        const headers = {'Orrery-Actor': await load()}
        if (existing.value) await $fetch<Schedule>(`${base}/${existing.value.id}`, {method: 'PATCH', headers, body})
        else await $fetch<Schedule>(base, {method: 'POST', headers, body})
        close()
    } catch (error) {
        failed.value = (error as {data?: {message?: string}}).data?.message ?? "Couldn't save it. Is Orrery running?"
    } finally {
        saving.value = false
    }
}

const field = 'h-8 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <Teleport to="body">
    <div v-if="editing" class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-[8vh] backdrop-blur-[2px]" @pointerdown.self="close">
      <form class="glass flex w-full max-w-2xl animate-fade-up flex-col gap-3 rounded-2xl p-5" role="dialog" :aria-label="existing ? 'Edit schedule' : 'New schedule'" @submit.prevent="save" @keydown.esc.stop="close" @keydown.meta.enter.prevent="save" @keydown.ctrl.enter.prevent="save">
        <div class="flex items-center gap-2 text-xs text-faint">
          <SectionIcon section="schedules" />
          <span>{{ existing ? 'Edit schedule in' : 'New schedule in' }}</span>
          <span class="text-fg">{{ here?.name ?? project }}</span>
          <KeyHint class="ml-auto">esc</KeyHint>
        </div>

        <SegmentedControl v-model="sends" :options="SENDS" class="self-start" />
        <input
            ref="titleInput"
            v-model="title"
            :placeholder="sends === 'issue' ? 'What to do, e.g. Groom the backlog' : 'Its name, e.g. Check CI'"
            aria-label="Title"
            class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none"
        >
        <textarea
            v-model="notes"
            rows="3"
            :placeholder="sends === 'issue' ? 'Instructions for each run… (Markdown works; it\'s the issue\'s description)' : 'The message the sessions get each run, e.g. Check CI on main; if it\'s red, tell me why'"
            :aria-label="sends === 'issue' ? 'Instructions' : 'Message'"
            class="resize-y bg-transparent text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
        />

        <section class="flex flex-col gap-2 border-t border-line pt-3">
          <span class="label">When</span>
          <div class="flex flex-wrap items-center gap-2">
            <select v-model="kind" aria-label="Repeats" :class="field">
              <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
            <template v-if="['daily', 'weekdays', 'weekly', 'monthly'].includes(kind)">
              <template v-if="kind === 'monthly'">
                <span class="text-xs text-muted">on day</span>
                <input v-model.number="day" type="number" min="1" max="31" aria-label="Day of the month" :class="[field, 'w-16']">
              </template>
              <span class="text-xs text-muted">at</span>
              <input v-model="time" type="time" aria-label="Time" :class="field">
            </template>
            <template v-else-if="kind === 'minutes'">
              <span class="text-xs text-muted">every</span>
              <select v-model.number="everyMinutes" aria-label="Every how many minutes" :class="field">
                <option v-for="n in [5, 10, 15, 20, 30]" :key="n" :value="n">{{ n }} minutes</option>
              </select>
            </template>
            <template v-else-if="kind === 'hours'">
              <span class="text-xs text-muted">every</span>
              <select v-model.number="every" aria-label="Every how many hours" :class="field">
                <option v-for="n in [1, 2, 3, 4, 6, 8, 12]" :key="n" :value="n">{{ n === 1 ? 'hour' : `${n} hours` }}</option>
              </select>
              <span class="text-xs text-muted">at minute</span>
              <input v-model.number="minute" type="number" min="0" max="59" aria-label="Minute" :class="[field, 'w-16']">
            </template>
            <input v-else-if="kind === 'once'" v-model="once" type="datetime-local" aria-label="When" :class="field">
            <input v-else v-model="cron" placeholder="minute hour day month weekday" aria-label="Cron" :class="[field, 'w-52 font-mono']">
          </div>
          <div v-if="kind === 'weekly'" class="flex gap-1">
            <button
                v-for="d in [1, 2, 3, 4, 5, 6, 0]"
                :key="d"
                type="button"
                class="h-7 w-10 rounded-md text-xs ring-1"
                :class="days.includes(d) ? 'bg-accent-500/15 font-medium text-accent-700 ring-accent-500/40 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover'"
                :aria-pressed="days.includes(d)"
                @click="toggleDay(d)"
            >{{ DAYS[d] }}</button>
          </div>
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
            <template v-if="upcoming.length">
              <span>Next:</span>
              <span v-for="t in upcoming" :key="t.toISOString()" class="rounded bg-well px-1.5 py-px text-muted ring-1 ring-line">{{ when(t, timezone) }}</span>
            </template>
            <span v-else class="text-rose-600 dark:text-rose-400">{{ kind === 'once' ? 'Pick a time that hasn’t passed' : 'That doesn’t give a time yet' }}</span>
            <label class="ml-auto flex items-center gap-1">
              <span>Timezone</span>
              <input v-model="timezone" aria-label="Timezone" class="h-6 w-36 rounded-md bg-well px-1.5 text-xs text-fg ring-1 ring-line focus:outline-none">
            </label>
          </p>
        </section>

        <p v-if="sends === 'message'" class="border-t border-line pt-3 text-xs text-muted">
          Each run sends this to {{ here?.name ?? 'the project' }}'s listening Claude sessions, with no issue. If none is listening, the next one to connect within a day gets it.
        </p>
        <section v-else class="flex flex-col gap-2 border-t border-line pt-3">
          <span class="label">Each run makes an issue</span>
          <div class="flex flex-wrap items-center gap-2">
            <select v-model="column" aria-label="Where it starts" :class="field">
              <option v-for="p in PLACES" :key="p" :value="p">{{ PLACE_LABEL[p] }}</option>
            </select>
            <select v-model="priority" aria-label="Priority" :class="field">
              <option value="">No priority</option>
              <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }} · {{ PRIORITY_LABEL[p] }}</option>
            </select>
            <select v-model="chunk" aria-label="Chunk" :class="[field, 'max-w-56']">
              <option value="">No chunk</option>
              <option v-for="c in chunks" :key="c.id" :value="c.id">{{ c.title }}</option>
            </select>
            <LabelPicker v-model="labels" :labels="known" />
          </div>
          <label class="flex items-center gap-1.5 text-xs text-muted">
            <input v-model="ask" type="checkbox" class="accent-accent-500">
            Ask {{ here?.name ?? 'the project' }}'s Claude sessions to pick it up (if none is listening, the next one to connect gets it)
          </label>
          <label class="flex items-center gap-1.5 text-xs text-muted">
            <input v-model="skipOpen" type="checkbox" class="accent-accent-500">
            Skip a run while the last run's issue isn't done
          </label>
        </section>

        <div class="flex items-center gap-2 border-t border-line pt-3">
          <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <button type="submit" class="ml-auto flex h-8 items-center gap-2 rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="!ready">
            {{ saving ? 'Saving…' : existing ? 'Save schedule' : 'Create schedule' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
