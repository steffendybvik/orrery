<script setup lang="ts">
import type {LoginRecord} from '#shared/roadmap'

// Signed in on App settings (ORR-838): each browser and phone with a login, when it was made and last used, with End on
// each and End every other login, so a lost phone is shut out from here. Ending works at once: its next request asks
// for a login again.
const {load} = useOwner()
const logins = ref<LoginRecord[]>([])
const loaded = ref(false)
const busy = ref(false)
const failed = ref('')
const others = computed(() => logins.value.filter(login => !login.current))

const headers = async () => ({'Orrery-Actor': await load()})
async function refresh() {
    logins.value = await apiFetch<LoginRecord[]>('/logins', {headers: await headers()})
    loaded.value = true
}
onMounted(() => refresh().catch(error => failed.value = errorMessage(error)))

async function act(what: () => Promise<unknown>) {
    busy.value = true
    failed.value = ''
    try {
        await what()
        await refresh()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
const end = async (id: string) => act(async () => apiFetch(`/logins/${id}`, {method: 'DELETE', headers: await headers()}))
const endOthers = async () => act(async () => apiFetch('/logins', {method: 'DELETE', headers: await headers()}))
const when = (stamp: string) => new Date(stamp).toLocaleString()
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul v-if="logins.length" class="flex flex-col gap-1" aria-label="Logins">
      <li v-for="login in logins" :key="login.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1.5 py-1 text-xs text-fg">
        <span class="font-medium">{{ login.name ?? 'Browser' }}</span>
        <span v-if="login.current" class="text-muted">this browser</span>
        <span class="text-muted">{{ login.person }}</span>
        <span class="text-faint">{{ login.created_at ? `signed in ${when(login.created_at)}` : 'signed in before orrery kept the date' }}</span>
        <span v-if="login.last_used_at" class="text-faint">last used {{ when(login.last_used_at) }}</span>
        <UiButton v-if="!login.current" variant="danger-ghost" size="xs" class="ml-auto" :disabled="busy" :aria-label="`End ${login.name ?? 'Browser'}, signed in ${login.created_at ? when(login.created_at) : 'earlier'}`" @click="end(login.id)">End</UiButton>
      </li>
    </ul>
    <p v-else-if="loaded" class="text-xs text-muted">Nothing is signed in: no browser or phone has a login.</p>
    <div v-if="others.length > 1">
      <UiButton variant="danger-ghost" size="md" :disabled="busy" @click="endOthers">End every other login</UiButton>
    </div>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
