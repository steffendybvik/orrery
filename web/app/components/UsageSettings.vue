<script setup lang="ts">
import type {FeatureUse} from '#shared/usage'

// Usage, on App settings → Advanced (ORR-881): which features the owner uses, coldest first, to find what can go. Off
// until the owner turns it on; turned off again, it offers to delete what's been counted. Only the owner's own use is
// counted, and only the owner sees this (others get nothing: GET /api/usage is theirs).
const {settings, save} = useAppSettings()
const {load: owner} = useOwner()
const headers = async () => ({'Orrery-Actor': await owner()})
const usage = ref<{on: boolean, allowed: boolean, features: FeatureUse[]} | null>(null)
const failed = ref('')
const offerDelete = ref(false)
const busy = ref(false)

async function load() {
    try {
        usage.value = await apiFetch('/usage', {headers: await headers()})
    } catch {
        usage.value = null
    }
}
onMounted(load)

async function setOn(on: boolean) {
    failed.value = ''
    busy.value = true
    try {
        await save({count_use: on})
        offerDelete.value = !on && !!usage.value?.features.some(f => f.last)
        await load()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
async function forget() {
    busy.value = true
    try {
        await apiFetch('/usage', {method: 'DELETE', headers: await headers()})
        offerDelete.value = false
        await load()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
const counted = computed(() => usage.value?.features.some(f => f.last) ?? false)
</script>

<template>
  <div v-if="usage" class="flex flex-col gap-3">
    <p v-if="!usage.allowed" class="text-xs text-muted">
      This server doesn't count anyone's use: <code class="font-mono">ORRERY_USAGE=off</code> is set.
    </p>
    <template v-else>
      <label class="flex items-center gap-2 text-[13px] text-fg">
        <input type="checkbox" class="accent-accent-fill" :checked="settings.count_use" :disabled="busy" @change="setOn(($event.target as HTMLInputElement).checked)">
        Count what I use
      </label>
      <div v-if="offerDelete" class="flex flex-wrap items-center gap-2 text-xs text-muted">
        Counting is off. Keep what's been counted, or delete it?
        <UiButton size="xs" :disabled="busy" @click="forget">Delete the counts</UiButton>
        <UiButton size="xs" variant="ghost" @click="offerDelete = false">Keep them</UiButton>
      </div>
    </template>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    <table v-if="counted || settings.count_use" class="w-full text-left text-[13px]" aria-label="Feature use">
      <thead class="text-[11px] uppercase tracking-wide text-faint">
        <tr><th class="py-1 font-medium">Feature</th><th class="py-1 font-medium">Last used</th><th class="py-1 text-right font-medium">30 days</th><th class="py-1 text-right font-medium">90 days</th></tr>
      </thead>
      <tbody>
        <tr v-for="f in usage.features" :key="f.feature" class="border-t border-line" :data-feature="f.feature">
          <td class="py-1 text-fg">{{ f.label }}<span v-if="f.feature.includes(':')" class="ml-1.5 text-[11px] text-faint">{{ f.feature.split(':')[0] }}</span></td>
          <td class="py-1 text-muted">{{ f.last ?? 'never' }}</td>
          <td class="py-1 text-right font-mono tabular-nums text-muted">{{ f.days30 }}</td>
          <td class="py-1 text-right font-mono tabular-nums" :class="f.days90 ? 'text-muted' : 'text-amber-800 dark:text-amber-300'">{{ f.days90 }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
