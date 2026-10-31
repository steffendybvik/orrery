<script setup lang="ts">
import type {KeyRecord} from '#shared/roadmap'

// Your keys on Settings (ORR-664): an agent key for each machine's sessions, and a person key to sign in to the page where
// there's no provider. A key shows once, as it's made; only a hash is kept. Revoking works at once.
const {load} = useOwner()
const {logOut} = useAuth()
const keys = ref<KeyRecord[]>([])
const kind = ref<'agent' | 'person'>('agent')
const name = ref('')
const made = ref('')
const busy = ref(false)
const failed = ref('')

const headers = async () => ({'Orrery-Actor': await load()})
async function refresh() {
    keys.value = await apiFetch<KeyRecord[]>('/keys', {headers: await headers()})
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
const make = () => act(async () => {
    const {key} = await apiFetch<{key: string}>('/keys', {method: 'POST', body: {kind: kind.value, name: name.value}})
    made.value = key
    name.value = ''
})
const revoke = (id: string) => act(() => apiFetch(`/keys/${id}`, {method: 'DELETE'}))
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul v-if="keys.length" class="flex flex-col gap-1">
      <li v-for="key in keys" :key="key.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1.5 py-1 text-xs" :class="key.revoked_at ? 'text-faint line-through' : 'text-fg'">
        <span class="font-medium">{{ key.name }}</span>
        <span class="text-muted">{{ key.kind === 'agent' ? 'Agent key' : 'Person key' }}, {{ key.person }}</span>
        <span class="text-faint">{{ key.last_used_at ? `last used ${new Date(key.last_used_at).toLocaleString()}` : 'not used yet' }}</span>
        <UiButton v-if="!key.revoked_at" variant="danger-ghost" size="xs" class="ml-auto" :disabled="busy" :aria-label="`Revoke ${key.name}`" @click="revoke(key.id)">Revoke</UiButton>
      </li>
    </ul>
    <form class="flex flex-wrap items-center gap-2" @submit.prevent="make">
      <input v-model="name" aria-label="What the key is for" placeholder="What it's for, such as this laptop" maxlength="60" class="h-8 w-72 max-w-full field">
      <select v-model="kind" aria-label="Kind of key" class="h-8 field">
        <option value="agent">Agent key</option>
        <option value="person">Person key</option>
      </select>
      <UiButton type="submit" variant="primary" size="md" :disabled="busy || !name.trim()">Make a key</UiButton>
    </form>
    <div v-if="made" class="flex flex-col gap-1 text-xs text-muted">
      <p>Shown this once. An agent key goes in <code class="font-mono">ORRERY_KEY</code> where you start Claude Code; a person key signs you in here, and never goes in a session's environment.</p>
      <code class="select-all break-all rounded-md bg-hover px-2 py-1 font-mono text-fg">{{ made }}</code>
    </div>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    <div>
      <UiButton @click="logOut">Log out</UiButton>
    </div>
  </div>
</template>
