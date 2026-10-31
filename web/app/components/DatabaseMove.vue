<script setup lang="ts">
import type {DatabaseCheck, DatabaseInfo} from '#shared/roadmap'

// Move to another database (App settings → Database): pick SQLite or Postgres, say where, and orrery checks it
// first. An empty one has everything copied in; an orrery's own is run on as it is. orrery switches at once and
// keeps the choice for its next start; the database it leaves stays as it was. The page loads again after, since
// the projects may be others. `first` is the first-open step (OwnerDialog): open from the start, inside that dialog's
// form, with Back in place of Cancel.
const props = defineProps<{database: DatabaseInfo, first?: boolean}>()
const emit = defineEmits<{back: []}>()

type Kind = 'sqlite' | 'postgres'
const KINDS: {value: Kind, label: string}[] = [{value: 'sqlite', label: 'SQLite file'}, {value: 'postgres', label: 'Postgres'}]
type Entry = 'url' | 'fields'
const ENTRIES: {value: Entry, label: string}[] = [{value: 'url', label: 'URL'}, {value: 'fields', label: 'Details'}]

const open = ref(!!props.first)
const kind = ref<Kind>(props.first || props.database.kind === 'sqlite' ? 'postgres' : 'sqlite')
const entry = ref<Entry>('url')
const path = ref('')
const url = ref('')
const fields = reactive({host: '', port: '5432', name: '', user: '', password: ''})
const check = ref<DatabaseCheck | null>(null)
const busy = ref(false)
const failed = ref('')

/** The Postgres URL the details make, each part escaped. */
const builtUrl = computed(() => {
    const auth = fields.user ? `${encodeURIComponent(fields.user)}${fields.password ? `:${encodeURIComponent(fields.password)}` : ''}@` : ''
    return `postgres://${auth}${fields.host.trim()}${fields.port.trim() ? `:${fields.port.trim()}` : ''}/${encodeURIComponent(fields.name.trim())}`
})
const target = computed(() => kind.value === 'sqlite' ? {kind: 'sqlite', path: path.value} : {kind: 'postgres', url: entry.value === 'url' ? url.value : builtUrl.value})
const ready = computed(() => kind.value === 'sqlite' ? !!path.value.trim() : entry.value === 'url' ? !!url.value.trim() : !!fields.host.trim() && !!fields.name.trim())

// What was checked is for what was entered: changing it asks again.
watch([kind, entry, path, url, fields], () => {
    check.value = null
    failed.value = ''
})

async function send(route: '/database/check' | '/database/move', body: object) {
    return await apiFetch(route, {method: 'POST', body})
}

async function checkIt() {
    busy.value = true
    failed.value = ''
    try {
        check.value = await send('/database/check', target.value) as DatabaseCheck
    } catch (error) {
        failed.value = errorMessage(error, 'check it')
    } finally {
        busy.value = false
    }
}

const moved = ref(false)
async function move(how: 'copy' | 'use') {
    busy.value = true
    failed.value = ''
    try {
        await send('/database/move', {...target.value, how})
        moved.value = true
        location.reload()
    } catch (error) {
        failed.value = errorMessage(error, 'move it')
        busy.value = false
    }
}

const STATE: Record<DatabaseCheck['state'], string> = {
    empty: 'Empty: everything here is copied into it, then orrery runs on it.',
    orrery: 'Already an orrery\'s.',
    current: 'That\'s the database orrery runs on now.',
    other: 'It has tables of something else\'s: give orrery a database of its own.',
}
const input = 'h-7 rounded-md bg-well px-2 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="!open">
      <UiButton size="xs" @click="open = true">Move to another database…</UiButton>
    </div>

    <!-- Not a form of its own: in the first-open dialog it's inside one. Enter checks it. -->
    <div v-else class="flex flex-col gap-2.5 rounded-xl bg-well/50 p-3 ring-1 ring-line" @keydown.enter.prevent="!check && ready && !busy && checkIt()">
      <SegmentedControl v-if="!first" v-model="kind" :options="KINDS" class="self-start" />

      <template v-if="kind === 'sqlite'">
        <input v-model="path" placeholder="orrery-2.db, or a full path" aria-label="SQLite file" autocomplete="off" :class="[input, 'w-full font-mono']">
        <p class="text-xs text-faint">A file on the machine orrery runs on. A name alone goes in the data folder, beside the one now; in Docker, only the data volume outlives the container.</p>
      </template>

      <template v-else>
        <SegmentedControl v-model="entry" :options="ENTRIES" class="self-start" />
        <input
            v-if="entry === 'url'"
            v-model="url"
            type="password"
            placeholder="postgres://user:password@host:5432/name"
            aria-label="Postgres URL"
            autocomplete="off"
            :class="[input, 'w-full font-mono']"
        >
        <div v-else class="grid grid-cols-[1fr_5rem] gap-2 sm:grid-cols-[2fr_5rem_1fr]">
          <input v-model="fields.host" placeholder="Host" aria-label="Host" autocomplete="off" :class="[input, 'font-mono']">
          <input v-model="fields.port" placeholder="5432" aria-label="Port" inputmode="numeric" autocomplete="off" :class="[input, 'font-mono']">
          <input v-model="fields.name" placeholder="Database" aria-label="Database name" autocomplete="off" :class="[input, 'font-mono max-sm:col-span-2']">
          <input v-model="fields.user" placeholder="User" aria-label="User" autocomplete="off" :class="[input, 'font-mono']">
          <input v-model="fields.password" type="password" placeholder="Password" aria-label="Password" autocomplete="new-password" :class="[input, 'font-mono sm:col-span-2']">
        </div>
        <p class="text-xs text-faint">Your own, or a hosted one's connection URL pasted as it is. Give orrery a database of its own: it checks there's nothing else in it.</p>
      </template>

      <p v-if="check" class="text-[13px] text-fg">
        <code class="font-mono text-xs">{{ check.where }}</code>:
        {{ first && check.state === 'empty' ? 'Empty: orrery sets it up and keeps everything there.' : STATE[check.state] }}
        <template v-if="check.state === 'orrery'">
          {{ check.projects ? `${check.projects} project${check.projects === 1 ? '' : 's'} in it. orrery runs on it as it is, and what's here stays behind in this one.` : 'No projects in it yet: everything here is copied in.' }}
        </template>
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <UiButton v-if="!check" variant="primary" :disabled="busy || !ready" @click="checkIt">{{ busy ? 'Checking…' : 'Check it' }}</UiButton>
        <UiButton v-else-if="check.state === 'empty' || (check.state === 'orrery' && !check.projects)" variant="primary" :disabled="busy" @click="move('copy')">
          {{ busy ? 'Setting it up…' : first ? 'Use it' : 'Copy and move' }}
        </UiButton>
        <UiButton v-else-if="check.state === 'orrery'" variant="warning-outline" :disabled="busy" @click="move('use')">
          {{ busy ? 'Moving…' : 'Run on it as it is' }}
        </UiButton>
        <UiButton v-if="first" :disabled="busy" @click="emit('back')">Back</UiButton>
        <UiButton v-else :disabled="busy" @click="open = false">Cancel</UiButton>
        <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
        <span v-else-if="moved" class="text-xs text-muted">Moved. Loading it…</span>
      </div>
      <p v-if="!first" class="text-xs text-faint">
        The database it leaves stays as it was, so you can move back to it. What's written while it copies, a few seconds, stays behind there.
      </p>
    </div>
  </div>
</template>
