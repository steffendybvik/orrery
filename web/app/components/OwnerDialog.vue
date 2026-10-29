<script setup lang="ts">
// The first time an orrery is opened, it asks whose it is. That name is the owner's (what they make,
// no one else can delete), and their `Orrery-Actor` is it in lowercase snake case. A brand-new one (no projects) opened
// on this machine asks first where to keep its data (ORR-319): here, or Postgres, moved to as App settings does it, so
// ORRERY_DATABASE isn't needed. Not when ORRERY_DATABASE names Postgres, or once it's moved. Before either, a new one
// whose backup folder has backups asks whether to restore one (ORR-448): it never starts from one by itself.
// With the name it asks whether they're a developer (ORR-579): a no turns Advanced off (App settings → Advanced), so the
// sidebar leaves out Events, Context and Pull requests and orrery records only its errors.
import type {Backups} from '#shared/roadmap'

const {named, rename} = useOwner()
const {settings, save: saveSettings} = useAppSettings()
const {ordered} = useProjectOrder()
const THIS_MACHINE = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i
const asksData = computed(() => !!settings.value.database?.movable && !settings.value.database.moved && !ordered.value.length
    && THIS_MACHINE.test(location.hostname))
const step = ref<'restore' | 'data' | 'postgres' | 'name'>('restore')
const backups = ref<Backups | null>(null)
watch(named, async now => {
    if (!now && !backups.value) backups.value = await $fetch<Backups>('/api/backups').catch(() => null)
}, {immediate: true})
const asksRestore = computed(() => !!backups.value?.fresh && !!backups.value.snapshots.length)
const showing = computed(() => {
    if (step.value === 'restore' && asksRestore.value) return 'restore'
    return asksData.value ? step.value === 'restore' ? 'data' : step.value : 'name'
})
/** In Docker, a new one with no backups may have had its data in a volume of another name. */
const otherVolume = computed(() => !!backups.value?.fresh && backups.value.docker && !backups.value.snapshots.length)
const display = ref('')
const developer = ref(true)
const saving = ref(false)
const failed = ref('')
const input = ref<HTMLInputElement | null>(null)
watch([named, showing], ([now, at]) => {
    if (!now && at === 'name') nextTick(() => input.value?.focus())
}, {immediate: true})

/** As the server makes it: `Sköll Fenrisson` → `skoll_fenrisson`. */
const id = computed(() => display.value.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
const ready = computed(() => !!id.value && id.value !== 'agent' && !saving.value)

function submit() {
    if (showing.value === 'restore') return
    if (showing.value === 'data') step.value = 'name'
    else if (showing.value === 'name') save()
}

async function save() {
    if (!ready.value) return
    saving.value = true
    failed.value = ''
    try {
        await rename(display.value.trim())
        if (!developer.value && settings.value.advanced) await saveSettings({advanced: false})
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}
</script>

<template>
  <UiDialog
      :open="!named"
      :label="showing === 'name' ? 'Your name' : showing === 'restore' ? 'Restore a backup' : 'Where to keep its data'"
      :width="showing === 'postgres' || showing === 'restore' ? 'lg' : 'md'"
      required
      @submit="submit"
  >
    <template v-if="showing === 'restore' && backups">
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Found backups. Restore one?</h2>
        <p class="text-xs text-muted">
          This orrery is empty, and its backup folder has {{ backups.snapshots.length }} backup{{ backups.snapshots.length === 1 ? '' : 's' }}, the latest from
          {{ new Date(backups.snapshots[0]!.at).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) }}. Pick one to carry on from it, or start fresh.
        </p>
      </div>
      <BackupRestore :backups="backups" first @fresh="step = 'data'" />
    </template>
    <template v-else-if="showing !== 'name' && settings.database">
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Where should this orrery keep its data?</h2>
        <p class="text-xs text-muted">You can move it later in App settings → Database.</p>
      </div>
      <div v-if="showing === 'data'" class="flex flex-col gap-2">
        <button type="submit" class="flex flex-col items-start gap-0.5 rounded-xl p-3 text-left ring-1 ring-accent-500/50 hover:bg-hover">
          <span class="text-[13px] font-medium text-fg">On this machine</span>
          <span class="text-xs text-muted">A SQLite file in its data folder. Nothing to set up.</span>
        </button>
        <button type="button" class="flex flex-col items-start gap-0.5 rounded-xl p-3 text-left ring-1 ring-line hover:bg-hover" @click="step = 'postgres'">
          <span class="text-[13px] font-medium text-fg">Postgres</span>
          <span class="text-xs text-muted">Yours or a hosted one: for a team's server, or a database you already back up. An orrery's own from before picks up where it was.</span>
        </button>
      </div>
      <DatabaseMove v-else :database="settings.database" first @back="step = 'data'" />
    </template>
    <template v-else>
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Whose orrery is this?</h2>
        <p class="text-xs text-muted">You're its owner: what you make, no one else can delete. Change it later in Settings.</p>
      </div>
      <input ref="input" v-model="display" placeholder="Your name" aria-label="Your name" maxlength="60" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
      <p v-if="otherVolume" class="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300" data-other-volume>
        Had data here before? This orrery starts empty, and it may be in another Docker volume, from a folder with another name:
        see <code>docker volume ls</code>.
      </p>
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-[13px] font-medium text-fg">Are you a developer?</legend>
        <div class="flex gap-2">
          <label
              v-for="{value, label, note} in [{value: true, label: 'Yes', note: 'Show the pages for looking into problems'}, {value: false, label: 'No', note: 'Keep them out of the sidebar'}]"
              :key="label"
              class="flex flex-1 cursor-pointer items-start gap-2 rounded-lg p-2 ring-1 hover:bg-hover"
              :class="developer === value ? 'ring-accent-500/50' : 'ring-line'"
          >
            <input v-model="developer" type="radio" name="developer" :value="value" class="mt-0.5 accent-accent-500">
            <span class="flex flex-col gap-0.5">
              <span class="text-[13px] font-medium text-fg">{{ label }}</span>
              <span class="text-xs text-muted">{{ note }}</span>
            </span>
          </label>
        </div>
        <p class="text-xs text-faint">Those are Events, Context and Pull requests. Change it later in App settings → Advanced.</p>
      </fieldset>
      <p class="text-xs text-faint">
        Your <span class="font-mono text-muted">Orrery-Actor</span> header will be <span class="font-mono text-muted">{{ id || 'your_name' }}</span>
      </p>
      <div class="flex items-center gap-2 border-t border-line pt-3">
        <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
        <span v-else-if="id === 'agent'" class="text-xs text-rose-600 dark:text-rose-400">"agent" is what requests without a name are; pick another.</span>
        <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="!ready">
          {{ saving ? 'Saving…' : 'Continue' }}
        </UiButton>
      </div>
    </template>
  </UiDialog>
</template>
