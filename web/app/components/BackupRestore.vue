<script setup lang="ts">
// Restoring a backup (ORR-448): the copies in the backup folder, newest first, with when each was made, how big it is,
// and whose orrery it's a copy of, one picked and restored. orrery checks it whole first, keeps the database as it was
// in the backup folder, and runs on a copy of the backup from then on; the page loads again. One from another orrery
// (another name, or another id) says so. `first` is the first-open step (OwnerDialog): open from the start, with Start
// fresh in place of Cancel.
import type {Backups, Snapshot} from '#shared/roadmap'
import {bytes} from '~/utils/bytes'

const props = defineProps<{backups: Backups, id?: string, first?: boolean}>()
const emit = defineEmits<{fresh: []}>()

const open = ref(!!props.first)
const picked = ref(props.backups.snapshots[0]?.name ?? '')
const busy = ref(false)
const failed = ref('')
const restored = ref(false)

const KIND: Record<Snapshot['kind'], string> = {latest: 'Latest', daily: 'Daily', before: 'Before an upgrade or restore'}
/** A copy of another orrery's: one that ran under another name, or has another id than this one's. */
const other = (s: Snapshot) => (s.environment && s.environment !== props.backups.environment) || (!props.first && props.id && s.of && s.of !== props.id)
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})

async function restore() {
    if (!picked.value || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        await apiFetch('/backups/restore', {method: 'POST', body: {name: picked.value}})
        restored.value = true
        location.reload()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="!open">
      <UiButton size="xs" :disabled="!backups.snapshots.length" @click="open = true">Restore a backup…</UiButton>
    </div>

    <div v-else class="flex flex-col gap-2.5" :class="first ? '' : 'rounded-xl bg-well/50 p-3 ring-1 ring-line'" data-backup-restore>
      <ul class="flex max-h-72 flex-col gap-1 overflow-y-auto" role="radiogroup" aria-label="Backups">
        <li v-for="s in backups.snapshots" :key="s.name">
          <label
              class="flex cursor-pointer items-start gap-2.5 rounded-lg p-2 ring-1 hover:bg-hover"
              :class="picked === s.name ? 'ring-accent-500/50' : 'ring-transparent'"
          >
            <input v-model="picked" type="radio" name="backup" :value="s.name" class="mt-1 accent-accent-500">
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="text-[13px] font-medium text-fg">{{ when(s.at) }} <span class="font-normal text-muted">· {{ KIND[s.kind] }}</span></span>
              <span class="text-xs text-muted">
                {{ bytes(s.size) }}<template v-if="s.projects !== undefined"> · {{ s.projects }} project{{ s.projects === 1 ? '' : 's' }}</template>
                <template v-if="s.environment"> · from <span class="font-medium">{{ s.environment }}</span></template>
                <span v-if="s.of" class="font-mono text-faint">{{ ` (${s.of})` }}</span>
              </span>
              <span v-if="other(s)" class="text-xs text-amber-800 dark:text-amber-400">A copy of another orrery, not this one ({{ backups.environment }}).</span>
            </span>
          </label>
        </li>
      </ul>

      <div class="flex flex-wrap items-center gap-2">
        <UiButton :variant="first ? 'primary' : 'warning-outline'" :disabled="busy || !picked || !backups.restorable" @click="restore">
          <UiBusy :busy="busy" label="Restoring…">Restore it</UiBusy>
        </UiButton>
        <UiButton v-if="first" :disabled="busy" @click="emit('fresh')">Start fresh</UiButton>
        <UiButton v-else :disabled="busy" @click="open = false">Cancel</UiButton>
        <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
        <span v-else-if="restored" class="inline-flex items-center gap-1.5 text-xs text-muted"><UiSpinner />Restored. Loading it…</span>
      </div>
      <p class="text-xs text-faint">
        <template v-if="!backups.restorable">orrery restores from the app only when it runs on a SQLite file.</template>
        <template v-else>
          orrery checks the backup first, and keeps a copy of the database as it is now in the backup folder before it
          restores, so nothing is lost.
        </template>
      </p>
    </div>
  </div>
</template>
