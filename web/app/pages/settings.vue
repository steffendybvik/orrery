<script setup lang="ts">
import {TINTS, issueRef, trackerLinkOf} from '#shared/roadmap'
import type {Backups, DatabaseInfo} from '#shared/roadmap'
import type {Heading} from '~/utils/markdown'

// This orrery's own settings (a project's are on its Settings tab): whose it is, how issues work in every project, and
// the orrery itself: its tint, a colour the backgrounds take on, so one orrery (personal, work) looks unlike another at a
// glance, its secrets and where its data is.
useHead({title: 'App settings · orrery'})
const {settings, tintColor, save} = useAppSettings()
const {environment} = useRuntimeConfig().public
const failed = ref('')
// The settings by what they reach (ORR-285), each tab saying so: you, how issues work in every project, this orrery as
// a whole, and Advanced, the pages for looking into problems (ORR-561). A link to a section (`#tint`) opens its tab, even
// one naming the tab it used to be on (`?tab=orrery#advanced`). How sessions start and what they hear is on the Sessions page.
type Tab = 'you' | 'issues' | 'orrery' | 'advanced'
const TABS: {value: Tab, label: string, scope: string, sections: Heading[]}[] = [
    {value: 'you', label: 'You', scope: 'Who you are on this orrery, and how your issues are named outside it.', sections: [
        {id: 'name', text: 'Your name', level: 2},
        {id: 'handle', text: 'Your handle', level: 2},
        // Only when this orrery asks for a login (ORR-664): alone on your own machine, none of it shows.
        ...useAuth().status.value?.mode === 'on' ? [{id: 'keys', text: 'Your keys', level: 2 as const}] : [],
    ]},
    {value: 'issues', label: 'Issues', scope: "How issues work in every project on this orrery. A project's own settings are on its Settings tab.", sections: [
        {id: 'proposals', text: 'Proposals', level: 2},
        {id: 'tracker', text: 'Team tracker', level: 2},
        {id: 'statuses', text: 'Issue statuses', level: 2},
    ]},
    {value: 'orrery', label: 'This orrery', scope: 'This orrery as a whole: how it looks, the keys its agents use and where it keeps its data. How sessions start is under Sessions → Setup.', sections: [
        {id: 'tint', text: 'Background tint', level: 2},
        {id: 'people', text: 'People', level: 2},
        {id: 'secrets', text: 'Secrets', level: 2},
        {id: 'database', text: 'Database', level: 2},
    ]},
    {value: 'advanced', label: 'Advanced', scope: 'For looking into problems: what orrery records, its event log, what it puts into a session\'s context, and the open pull requests on GitHub.', sections: [
        {id: 'advanced', text: 'Advanced', level: 2},
        {id: 'events', text: 'Events', level: 2},
        {id: 'context', text: 'Context', level: 2},
        {id: 'pulls', text: 'Pull requests', level: 2},
    ]},
]
const tabs = TABS.map(({value, label}) => ({value, label}))
const route = useRoute()
const router = useRouter()
const tab = computed<Tab>({
    get: () => TABS.find(t => t.sections.some(h => `#${h.id}` === route.hash))?.value ?? TABS.find(t => t.value === route.query.tab)?.value ?? 'you',
    set: next => router.replace({query: {...route.query, tab: next === 'you' ? undefined : next}, hash: ''}),
})
// An address naming a section's old tab (`?tab=orrery#advanced`) is put right, so it reads as the tab it opens.
onMounted(() => {
    if (route.query.tab && route.query.tab !== tab.value) router.replace({query: {...route.query, tab: tab.value === 'you' ? undefined : tab.value}, hash: route.hash})
})
// The sections, listed beside them on a wide screen; each section's heading is its title here.
const headings = computed(() => TABS.find(t => t.value === tab.value)?.sections ?? [])
const title = Object.fromEntries(TABS.flatMap(t => t.sections).map(h => [h.id, h.text]))
const scroller = ref<HTMLElement | null>(null)
const custom = ref('#3b82f6')
watch(tintColor, now => {
    if (now) custom.value = now
}, {immediate: true})

// The owner's name, saved on Enter or on leaving the field; Esc puts it back. Their id follows it.
const {owner, load: loadOwner, rename} = useOwner()
onMounted(loadOwner)
const ownerName = ref('')
const ownerFailed = ref('')
watch(() => owner.value?.display, now => {
    ownerName.value = owner.value?.named ? now ?? '' : ''
}, {immediate: true})
async function saveOwner() {
    const next = ownerName.value.trim()
    if (!next || next === owner.value?.display) {
        ownerName.value = owner.value?.named ? owner.value.display : ''
        return
    }
    ownerFailed.value = ''
    try {
        await rename(next)
    } catch (error) {
        ownerFailed.value = errorMessage(error)
    }
}

// Your handle in issues' references, such as your GitHub login: saved like the name; empty uses your id.
const handle = ref('')
const handleFailed = ref('')
watch(() => settings.value.handle, now => {
    handle.value = now ?? ''
}, {immediate: true})
async function saveHandle() {
    const next = handle.value.trim()
    if (next === (settings.value.handle ?? '')) return
    handleFailed.value = ''
    try {
        await save({handle: next || null})
    } catch (error) {
        handleFailed.value = errorMessage(error)
    }
}

// Where the team's tracker shows a task, so an issue's team tasks open there; saved like the name.
// A link into the tracker that isn't a task's (its team or projects page) is turned into its task link, and said so.
const tracker = ref('')
const trackerFailed = ref('')
/** The task link a pasted link was turned into, to say so until the field changes again. */
const trackerTurned = ref('')
watch(() => settings.value.tracker, now => {
    tracker.value = now ?? ''
}, {immediate: true})
async function saveTracker() {
    const typed = tracker.value.trim()
    if (typed === (settings.value.tracker ?? '')) return
    trackerFailed.value = ''
    trackerTurned.value = ''
    const next = typed ? trackerLinkOf(typed) : null
    if (typed && !next) {
        trackerFailed.value = "That link opens the same page for every task: put {id} where a task's id goes, e.g. https://tracker.example.com/issue/{id}"
        return
    }
    try {
        await save({tracker: next})
        tracker.value = next ?? ''
        if (next && next !== typed) trackerTurned.value = next
    } catch (error) {
        trackerFailed.value = errorMessage(error)
    }
}

// Whether agents keep off a proposal until you decide it; saved as it's ticked.
const proposalsFailed = ref('')
async function restrictProposals(on: boolean) {
    proposalsFailed.value = ''
    try {
        await save({restrict_proposals: on})
    } catch (error) {
        proposalsFailed.value = errorMessage(error)
    }
}

// Advanced: the Events page and error notices in the bell, and what orrery does recorded as well as its errors.
const {newErrors} = useLoggedEvents()
// The open pull requests on the projects' repos, counted beside their link as the sidebar used to (ORR-565).
const {pulls, follow: followPulls} = useOpenPulls()
followPulls(120_000)
const advancedFailed = ref('')
async function setAdvanced(on: boolean) {
    advancedFailed.value = ''
    try {
        await save({advanced: on})
    } catch (error) {
        advancedFailed.value = errorMessage(error)
    }
}

// Back up now: the same backup each change makes a few seconds after, made at once, with when it was made.
const backingUp = ref(false)
const backupFailed = ref('')
async function backUpNow() {
    backingUp.value = true
    backupFailed.value = ''
    try {
        settings.value.database = await apiFetch<DatabaseInfo>('/backups', {method: 'POST'})
    } catch (error) {
        backupFailed.value = errorMessage(error)
    } finally {
        backingUp.value = false
    }
}

// The backups in the folder, to restore one (ORR-448): read when the page opens, and again after a backup.
const backups = ref<Backups | null>(null)
const loadBackups = async () => {
    backups.value = await apiFetch<Backups>('/backups').catch(() => backups.value)
}
onMounted(loadBackups)
watch(() => settings.value.database?.backed_up_at, loadBackups)

/** The latest backup is old enough to look into (ORR-448): over two days, while backups are on. */
const STALE = 48 * 60 * 60_000
const backupStale = computed(() => {
    const at = settings.value.database?.backed_up_at
    return !!at && Date.now() - new Date(at).getTime() > STALE
})

// Whether the database is backed up, and where: a folder (outside Docker, any; in it, ORRERY_BACKUP's), or a Postgres
// database (ORR-427). Ticked or saved, and turned on it's backed up there at once, so a place that won't take it says
// so here. The kind starts on where they go now, else on the database's own kind.
type BackupKind = 'folder' | 'postgres'
const BACKUP_KINDS: {value: BackupKind, label: string}[] = [{value: 'folder', label: 'Folder'}, {value: 'postgres', label: 'Postgres'}]
const backupKind = ref<BackupKind>('folder')
const backupFolder = ref('')
const backupUrl = ref('')
const settingBackups = ref(false)
const backupsFailed = ref('')
watch(() => settings.value.database, now => {
    backupFolder.value = now?.backup_folder ?? (now?.backup_kind ? '' : now?.backup) ?? now?.backup_default ?? ''
    backupKind.value = now?.backup_kind === 'postgres' || now?.backup_postgres || (!now?.backup && now?.kind === 'postgres') ? 'postgres' : 'folder'
    backupUrl.value = ''
}, {immediate: true})
async function putBackups(body: object) {
    settingBackups.value = true
    backupsFailed.value = ''
    try {
        settings.value.database = await apiFetch<DatabaseInfo>('/backups', {method: 'PUT', body})
    } catch (error) {
        backupsFailed.value = errorMessage(error)
    } finally {
        settingBackups.value = false
    }
}
function setBackups(on: boolean, folder: string | null = backupFolder.value.trim() || null) {
    // Postgres with no URL typed keeps the one chosen before, whose password the page doesn't have. A folder says so
    // (`null`: orrery's own), so it isn't taken for that Postgres database.
    return putBackups(backupKind.value === 'postgres' ? (backupUrl.value.trim() ? {on, postgres: backupUrl.value.trim()} : {on})
        : settings.value.database?.backups_settable === 'folder' ? {on, folder} : {on, folder: null})
}

// How often it backs up and how many daily copies stay (ORR-445), each saved as it's picked.
const BACKUP_EVERY = [
    {value: 'change' as const, label: 'After a change'},
    {value: '15m' as const, label: 'Every 15 min'},
    {value: 'hour' as const, label: 'Hourly'},
    {value: 'day' as const, label: 'Daily'},
]
const backupEvery = computed({
    get: () => settings.value.database?.backup_every ?? 'change',
    set: every => putBackups({every}),
})
const backupKeep = ref(14)
watch(() => settings.value.database?.backup_keep, keep => backupKeep.value = keep ?? 14, {immediate: true})
function saveKeep() {
    const keep = backupKeep.value
    if (!Number.isInteger(keep) || keep < 1 || keep > 365) return void (backupsFailed.value = 'Keep 1 to 365 daily copies')
    if (keep !== settings.value.database?.backup_keep) putBackups({keep})
}

async function pick(tint: string | null) {
    failed.value = ''
    try {
        await save({tint})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <PageHeader>
    <SectionIcon section="settings" class="size-4 text-faint" />
    <h1 class="truncate text-sm font-medium">App settings</h1>
  </PageHeader>

  <ViewToolbar>
    <SegmentedControl v-model="tab" :options="tabs" />
  </ViewToolbar>

  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-6xl animate-fade-up gap-12 px-4 py-8 sm:px-8">
    <div class="flex min-w-0 max-w-3xl flex-1 flex-col gap-8 [&>section+section]:border-t [&>section+section]:border-line [&>section+section]:pt-8">
      <p class="-mb-2 text-xs text-muted">{{ TABS.find(t => t.value === tab)?.scope }}</p>

      <section v-if="tab === 'you'" id="name" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.name }}</h2>
          <p class="text-xs text-muted">
            You own this orrery: what you make, no one else can delete. Your <span class="font-mono">Orrery-Actor</span> header is
            <span class="font-mono">{{ owner?.name }}</span>; renaming moves what's yours to the new one.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveOwner">
          <input
              v-model="ownerName"
              aria-label="Your name"
              maxlength="60"
              class="h-8 w-72 max-w-full field"
              @blur="saveOwner"
              @keydown.esc="ownerName = owner?.named ? owner.display : ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="ownerFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ ownerFailed }}</span>
        </form>
      </section>

      <section v-if="tab === 'you'" id="handle" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.handle }}</h2>
          <p class="text-xs text-muted">
            Says whose board an issue is on, once colleagues have boards of their own: an issue's reference is
            <span class="font-mono">{{ issueRef(handle.trim() || owner?.name || 'owner', 'DOC-132') }}</span>, for commit bodies and PR descriptions.
            Your GitHub login works well; left empty, it's your id.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveHandle">
          <input
              v-model="handle"
              aria-label="Your handle"
              :placeholder="owner?.name"
              spellcheck="false"
              maxlength="39"
              class="h-8 w-72 max-w-full field font-mono"
              @blur="saveHandle"
              @keydown.esc="handle = settings.handle ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="handleFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ handleFailed }}</span>
        </form>
      </section>

      <section v-if="tab === 'you' && useAuth().status.value?.mode === 'on'" id="keys" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.keys }}</h2>
          <p class="text-xs text-muted">
            What your sessions and browsers show to prove who they are, now this orrery asks for a login.
          </p>
        </header>
        <KeySettings />
      </section>

      <section v-if="tab === 'issues'" id="proposals" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.proposals }}</h2>
          <p class="text-xs text-muted">
            A proposal isn't work until you approve it. While one waits on you, sessions can comment on it and put it up again,
            but not start it, assign it or put it in a release, so nothing gets built before you've said yes.
          </p>
        </header>
        <label class="flex items-center gap-2 text-[13px] text-fg">
          <input type="checkbox" class="accent-accent-fill" :checked="settings.restrict_proposals" @change="restrictProposals(($event.target as HTMLInputElement).checked)">
          Keep agents off proposals until you approve them
        </label>
        <p v-if="proposalsFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ proposalsFailed }}</p>
      </section>

      <section v-if="tab === 'issues'" id="tracker" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.tracker }}</h2>
          <p class="text-xs text-muted">
            This board is yours; the team's tasks live on its tracker. An issue's Team tasks link there:
            give a task's web address with <span class="font-mono">{id}</span> where its id goes.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveTracker">
          <input
              v-model="tracker"
              type="url"
              aria-label="Team tracker"
              placeholder="https://tracker.example.com/issue/{id}"
              spellcheck="false"
              class="h-8 w-[28rem] max-w-full field font-mono"
              @blur="saveTracker"
              @keydown.esc="tracker = settings.tracker ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="trackerFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ trackerFailed }}</span>
        </form>
        <p v-if="trackerTurned" class="text-xs text-muted" role="status">
          Saved as a task link, with <span class="font-mono">{id}</span> where a task's id goes: <span class="font-mono text-fg">{{ trackerTurned }}</span>
        </p>
        <p v-else class="text-xs text-faint">
          For a tracker this board knows, a link to its team or projects page works too: it's saved as the link to a task.
        </p>
      </section>

      <section v-if="tab === 'issues'" id="statuses" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.statuses }}</h2>
          <p class="text-xs text-muted">
            The columns every project's issues move through. Each belongs to a kind, which is what orrery and your agents go by:
            add a status to a kind (In review, Blocked) and it counts, shows and signals like the rest of its kind.
          </p>
        </header>
        <StatusSettings />
      </section>

      <section v-if="tab === 'orrery'" id="tint" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.tint }}</h2>
          <p class="text-xs text-muted">
            Colours this orrery<template v-if="environment"> ({{ environment }})</template> so you can tell it from another at a glance. It's this orrery's own: each keeps its tint.
          </p>
        </header>
        <div class="flex flex-wrap items-center gap-2">
          <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ring-1 transition-colors"
              :class="!settings.tint ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
              :aria-pressed="!settings.tint"
              @click="pick(null)"
          >None</button>
          <button
              v-for="(color, name) in TINTS"
              :key="name"
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] capitalize ring-1 transition-colors"
              :class="settings.tint === name ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
              :aria-pressed="settings.tint === name"
              @click="pick(name)"
          >
            <span class="size-3.5 rounded-full ring-1 ring-black/10" :style="{background: color}" />
            {{ name }}
          </button>
          <label
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ring-1"
              :class="settings.tint?.startsWith('#') ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line'"
          >
            <input v-model="custom" type="color" aria-label="Custom tint" class="size-5 rounded border-0 bg-transparent p-0" @change="pick(custom)">
            Custom
          </label>
        </div>
        <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
      </section>

<section v-if="tab === 'orrery'" id="people" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.people }}</h2>
          <p class="text-xs text-muted">
            Who works on this orrery, each with their own agents. Alone, you need do nothing here.
          </p>
        </header>
        <PeopleSettings />
      </section>

            <section v-if="tab === 'orrery'" id="secrets" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.secrets }}</h2>
          <p class="text-xs text-muted">
            Keys your agents use to call outside services without ever seeing them. An agent puts
            <span class="font-mono">{{ '{' + '{secret:NAME}' + '}' }}</span> in a request, and orrery fills it in and sends it, over https, only to the hosts you allow.
            Taking a host off needs nothing more; letting a secret go somewhere new takes its value again.
          </p>
        </header>
        <SecretSettings />
      </section>

      <section v-if="tab === 'orrery'" id="database" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.database }}</h2>
          <p class="text-xs text-muted">
            Where this orrery keeps everything: a SQLite file on this machine, or Postgres, yours or a hosted one. Move it here
            from localhost, or set it as orrery starts with <code>ORRERY_DATABASE</code>
            (<a href="https://github.com/steffendybvik/orrery/blob/main/docs/running.md#postgres" target="_blank" rel="noopener" class="underline underline-offset-2 hover:text-fg">how</a>).
          </p>
        </header>
        <dl v-if="settings.database" class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[13px]">
          <dt class="text-muted">{{ settings.database.kind === 'postgres' ? 'Postgres' : 'SQLite file' }}</dt>
          <dd class="min-w-0">
            <DatabasePlace :path="settings.database.where" :host="settings.database.host" :volume="settings.database.volume">
              <span v-if="settings.database.moved" class="block text-xs text-faint">moved here from App settings</span>
            </DatabasePlace>
          </dd>
          <template v-if="settings.database.size !== undefined">
            <dt class="text-muted">Size</dt>
            <dd class="text-fg tabular-nums" :title="`${settings.database.size.toLocaleString()} bytes`">{{ bytes(settings.database.size) }}</dd>
          </template>
          <template v-if="settings.database.backup">
            <dt class="text-muted">Backed up to</dt>
            <dd class="min-w-0"><DatabasePlace :path="settings.database.backup" :host="settings.database.backup_host" :volume="settings.database.backup_volume" /></dd>
            <template v-if="settings.database.backup_size !== undefined">
              <dt class="text-muted">Backups</dt>
              <dd class="text-fg tabular-nums" :title="`${settings.database.backup_size.toLocaleString()} bytes`">{{ bytes(settings.database.backup_size) }}</dd>
            </template>
            <dt class="text-muted">Latest backup</dt>
            <dd class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span
                  :class="backupStale || settings.database.backup_failed ? 'font-medium text-amber-800 dark:text-amber-400' : 'text-fg'"
                  :title="settings.database.backed_up_at && new Date(settings.database.backed_up_at).toLocaleString()"
                  data-backup-latest
              >{{ settings.database.backed_up_at ? ago(settings.database.backed_up_at) : 'None yet' }}<template v-if="backupStale"> (over two days old)</template></span>
              <UiButton :disabled="backingUp" @click="backUpNow">{{ backingUp ? 'Backing up…' : 'Back up now' }}</UiButton>
              <span v-if="backupFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ backupFailed }}</span>
              <span
                  v-else-if="settings.database.backup_failed"
                  class="basis-full text-xs text-rose-700 dark:text-rose-400"
                  :title="new Date(settings.database.backup_failed.at).toLocaleString()"
                  data-backup-failed
              >The last try failed {{ ago(settings.database.backup_failed.at) }}: {{ settings.database.backup_failed.message }}</span>
            </dd>
          </template>
        </dl>
        <div v-if="settings.database?.backups_settable" class="flex flex-col gap-2">
          <label class="flex items-center gap-2 text-[13px] text-fg">
            <input
                type="checkbox"
                class="accent-accent-fill"
                :checked="!!settings.database.backup"
                :disabled="settingBackups || (backupKind === 'postgres' ? !backupUrl.trim() && !settings.database.backup_postgres : settings.database.backups_settable === 'switch' && !settings.database.backup_default)"
                @change="setBackups(($event.target as HTMLInputElement).checked)"
            >
            Back up this orrery
          </label>
          <SegmentedControl v-model="backupKind" :options="BACKUP_KINDS" class="self-start" />
          <form v-if="backupKind === 'postgres'" class="flex flex-wrap items-center gap-2" @submit.prevent="setBackups(true)">
            <input
                v-model="backupUrl"
                type="password"
                aria-label="Postgres URL for the backups"
                :placeholder="settings.database.backup_postgres ? 'Another Postgres URL, to back up there instead' : 'postgres://user:password@host:5432/name'"
                autocomplete="off"
                spellcheck="false"
                class="h-8 w-[28rem] max-w-full field font-mono"
                @keydown.esc="backupUrl = ''; ($event.target as HTMLInputElement).blur()"
            >
            <UiButton type="submit" :disabled="settingBackups || !backupUrl.trim()">{{ settingBackups ? 'Backing up…' : 'Back up there' }}</UiButton>
          </form>
          <form v-else-if="settings.database.backups_settable === 'folder'" class="flex flex-wrap items-center gap-2" @submit.prevent="setBackups(true)">
            <input
                v-model="backupFolder"
                aria-label="Backup folder"
                placeholder="/Users/you/Backups/orrery"
                spellcheck="false"
                class="h-8 w-[28rem] max-w-full field font-mono"
                @keydown.esc="backupFolder = settings.database.backup_folder ?? settings.database.backup ?? settings.database.backup_default ?? ''; ($event.target as HTMLInputElement).blur()"
            >
            <UiButton type="submit" :disabled="settingBackups || !backupFolder.trim()">{{ settingBackups ? 'Backing up…' : 'Back up here' }}</UiButton>
            <UiButton v-if="settings.database.backup_folder && settings.database.backup_default" variant="ghost" :disabled="settingBackups" @click="setBackups(!settings.database.backups_off, null)">Use {{ settings.database.backup_default }}</UiButton>
          </form>
          <div v-if="settings.database.backup" class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
            <span class="flex items-center gap-2">
              How often
              <SegmentedControl v-model="backupEvery" :options="BACKUP_EVERY" aria-label="How often to back up" />
            </span>
            <label v-if="settings.database.backup_kind !== 'postgres'" class="flex items-center gap-2">
              Daily copies kept
              <input
                  v-model.number="backupKeep"
                  type="number"
                  min="1"
                  max="365"
                  class="h-8 w-16 field tabular-nums"
                  :disabled="settingBackups"
                  @change="saveKeep"
                  @keydown.enter.prevent="saveKeep"
              >
            </label>
          </div>
          <p class="text-xs text-faint">
            <template v-if="backupKind === 'postgres'">
              An empty Postgres database, or this orrery's backup from before: each backup takes the place of the last, and a database
              holding another orrery, or anything else, is left alone. To restore, run on it (Move to another database…, then run on it as it is).
            </template>
            <template v-else-if="settings.database.backups_settable === 'folder'">A folder that syncs off this machine is best. Turned on, it's backed up there at once.</template>
            <template v-else-if="settings.database.backup_local">
              <span class="text-amber-800 dark:text-amber-400" data-backup-local>The backups are only on this computer, in a Docker volume.</span>
              Set <code>ORRERY_BACKUP</code> to a folder that leaves it (iCloud Drive, Dropbox, one Time Machine covers).
            </template>
            <template v-else-if="settings.database.backup_default">In Docker the backups go to <code>/backup</code>: choose its folder on this machine with <code>ORRERY_BACKUP</code>.</template>
            <template v-else>Give orrery a folder for its backups with <code>ORRERY_BACKUP</code>.</template>
            <template v-if="settings.database.backup && settings.database.backup_kind !== 'postgres'"> Each backup writes the whole database again, so a synced folder uploads it each time: back up less often to upload less. The daily copies are most of the folder's size.</template>
          </p>
          <p v-if="backupsFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ backupsFailed }}</p>
        </div>
        <p v-else-if="settings.database && !settings.database.backup" class="text-xs text-faint">
          Not backed up: give orrery a folder for its backups with <code>ORRERY_BACKUP</code> (<code>NUXT_BACKUP_DIR</code> outside Docker),
          or a Postgres database with <code>ORRERY_BACKUP_DATABASE</code> (<code>NUXT_BACKUP_DATABASE</code>).
        </p>
        <BackupRestore v-if="backups?.snapshots.length && backups.restorable" :backups="backups" :id="settings.id" />
        <DatabaseMove v-if="settings.database?.movable" :database="settings.database" />
        <p v-else-if="settings.database" class="text-xs text-faint">
          <code>ORRERY_DATABASE</code> names this Postgres, so it's moved there: copy the data with <code>pnpm orrery:copy</code>, change it and restart orrery.
        </p>
      </section>

      <section v-if="tab === 'advanced'" id="advanced" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.advanced }}</h2>
          <p class="text-xs text-muted">
            orrery always keeps a log of its errors, in the server and in this page, on this machine only.
            With Advanced on, which it is unless you turn it off, it also records what it does (sessions starting and stopping,
            launchers, schedule runs, backups, migrations) and each change to the roadmap, puts a notice in the bell for each new
            kind of error, and shows Events, Context and Pull requests in the sidebar under Schedules. They stay linked below
            either way.
          </p>
        </header>
        <label class="flex items-center gap-2 text-[13px] text-fg">
          <input type="checkbox" class="accent-accent-fill" :checked="settings.advanced" @change="setAdvanced(($event.target as HTMLInputElement).checked)">
          Record what orrery does, tell me about new errors, and show Events, Context and Pull requests in the sidebar
        </label>
        <p v-if="advancedFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ advancedFailed }}</p>
      </section>

      <section v-if="tab === 'advanced'" id="events" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.events }}</h2>
          <p class="text-xs text-muted">
            orrery's event log, read like a console: what went wrong and, with Advanced on, what it did and each change to the
            roadmap, a line each.
          </p>
        </header>
        <div class="flex items-center gap-2">
          <NuxtLink to="/events" class="text-[13px] font-medium text-accent-700 hover:underline dark:text-accent-400">Open the event log</NuxtLink>
          <span v-if="newErrors.length" class="rounded-full bg-rose-600 px-1.5 font-mono text-[10px] font-medium text-white tabular-nums" :title="`${newErrors.length} new kind${newErrors.length === 1 ? '' : 's'} of error`">{{ newErrors.length }}</span>
        </div>
      </section>

      <section v-if="tab === 'advanced'" id="context" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.context }}</h2>
          <p class="text-xs text-muted">
            What orrery puts into a session's context, part by part with its size, to see what to cut. A running session's is
            also on its card on the Sessions page while Advanced is on.
          </p>
        </header>
        <NuxtLink to="/context" class="self-start text-[13px] font-medium text-accent-700 hover:underline dark:text-accent-400">See what a session is sent</NuxtLink>
      </section>

      <section v-if="tab === 'advanced'" id="pulls" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.pulls }}</h2>
          <p class="text-xs text-muted">
            Every open pull request on the projects' GitHub repos, those that need someone (conflicts, failing checks, behind
            their base) first. An issue's own show on its page.
          </p>
        </header>
        <div class="flex items-center gap-2">
          <NuxtLink to="/pulls" class="text-[13px] font-medium text-accent-700 hover:underline dark:text-accent-400">Open pull requests</NuxtLink>
          <span v-if="pulls?.needs" class="rounded-full bg-rose-600 px-1.5 font-mono text-[10px] font-medium text-white tabular-nums" :title="`${pulls.needs} need${pulls.needs === 1 ? 's' : ''} someone: conflicts, failing checks or behind`">{{ pulls.needs }}</span>
          <span v-else-if="pulls?.open" class="font-mono text-[11px] text-faint tabular-nums">{{ pulls.open }}</span>
          <span v-else-if="pulls && !pulls.repos.length" class="text-xs text-faint">No project has a repo on GitHub yet.</span>
        </div>
      </section>
    </div>
    <aside class="hidden w-56 shrink-0 xl:block">
      <div class="sticky top-6">
        <DocContents :headings="headings" :root="scroller" />
      </div>
    </aside>
    </div>
  </div>
</template>
