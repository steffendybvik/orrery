<script setup lang="ts">
import type {Secret} from '#shared/roadmap'

// The Orrery's secrets on App settings: each by name, the last 4 characters of its value, the hosts it may
// go to, the projects that may use it, and its last use. Set or replace one with its value (which never
// comes back); take a host off without it, since that only narrows where it goes. Saved as the owner.
const {secrets, load: loadSecrets} = useSecretList()
const {load} = useOwner()
const {projects} = useRoadmaps()
const failed = ref('')
const busy = ref(false)
const missingKey = ref(false)
onMounted(() => loadSecrets().catch(error => failed.value = errorMessage(error)))

async function call(name: string, method: 'PUT' | 'PATCH' | 'DELETE', body?: Record<string, unknown>) {
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`/api/secrets/${encodeURIComponent(name)}`, {method: method as 'PUT', headers: {'Orrery-Actor': await load()}, body})
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        missingKey.value = failed.value.includes('ORRERY_SECRET_KEY')
        return false
    } finally {
        busy.value = false
    }
}

// The form sets a new secret, or replaces one (its name fixed, the value typed again).
const editing = ref<string | null>(null)
const form = reactive({name: '', value: '', hosts: '', projects: [] as string[]})
function open(secret?: Secret) {
    editing.value = secret?.name ?? ''
    Object.assign(form, {name: secret?.name ?? '', value: '', hosts: secret?.hosts.join(', ') ?? '', projects: [...secret?.projects ?? []]})
}
const list = (text: string) => text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
async function save() {
    const name = form.name.trim().toUpperCase()
    if (await call(name, 'PUT', {value: form.value, hosts: list(form.hosts), projects: form.projects.length ? form.projects : null})) {
        editing.value = null
        form.value = ''
    }
}

const removing = ref<string | null>(null)
async function remove(secret: Secret) {
    if (await call(secret.name, 'DELETE')) removing.value = null
}

const dropHost = (secret: Secret, host: string) => call(secret.name, 'PATCH', {hosts: secret.hosts.filter(h => h !== host)})
const projectName = (id: string) => projects.value.find(p => p.id === id)?.name ?? id

const input = 'h-7 rounded-md bg-well px-2 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
const iconButton = 'grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent'
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="secrets.length" class="flex flex-col rounded-xl bg-well/50 p-2 ring-1 ring-line">
      <div v-for="secret in secrets" :key="secret.name" class="flex flex-col">
        <div class="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1.5 py-1 hover:bg-hover/60">
          <span class="font-mono text-[13px] text-fg">{{ secret.name }}</span>
          <span class="font-mono text-[11px] text-faint" :title="`Ends in ${secret.last4}`">••••{{ secret.last4 }}</span>
          <span class="flex flex-wrap items-center gap-1">
            <span v-for="host in secret.hosts" :key="host" class="flex items-center gap-0.5 rounded-md bg-active px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {{ host }}
              <button
                  v-if="secret.hosts.length > 1"
                  type="button"
                  class="text-faint hover:text-fg disabled:opacity-30"
                  :disabled="busy"
                  :title="`Stop ${secret.name} going to ${host}`"
                  :aria-label="`Stop ${secret.name} going to ${host}`"
                  @click="dropHost(secret, host)"
              >×</button>
            </span>
          </span>
          <span v-if="secret.projects" class="text-xs text-faint">only {{ secret.projects.map(projectName).join(', ') }}</span>
          <span class="ml-auto flex items-center gap-1">
            <span
                class="text-xs text-faint"
                :title="secret.lastUsed ? `${secret.lastUsed.method} ${secret.lastUsed.host}${secret.lastUsed.path} by ${secret.lastUsed.createdBy}: ${secret.lastUsed.status ?? secret.lastUsed.error}` : undefined"
            >
              <template v-if="secret.lastUsed">
                used {{ ago(secret.lastUsed.createdAt) }}
                <span :class="secret.lastUsed.status && secret.lastUsed.status < 400 ? '' : 'text-rose-600 dark:text-rose-400'">· {{ secret.lastUsed.status ?? 'failed' }}</span>
              </template>
              <template v-else>never used</template>
            </span>
            <button type="button" class="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg" @click="open(secret)">Replace</button>
            <button type="button" :class="iconButton" :disabled="busy" :aria-label="`Delete ${secret.name}`" @click="removing = secret.name">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </span>
        </div>
        <div v-if="removing === secret.name" class="flex flex-wrap items-center gap-2 px-1.5 py-1.5 text-xs text-muted">
          Delete {{ secret.name }}? Agents using it get a 404; its uses stay on record.
          <button type="button" class="h-7 rounded-md bg-rose-600 px-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="busy" @click="remove(secret)">Delete</button>
          <button type="button" class="h-7 rounded-md px-2.5 text-xs text-muted ring-1 ring-line hover:bg-hover" @click="removing = null">Cancel</button>
        </div>
      </div>
    </div>

    <form v-if="editing !== null" class="flex flex-col gap-2 rounded-xl bg-well/50 p-3 ring-1 ring-line" @submit.prevent="save">
      <div class="flex flex-wrap items-center gap-2">
        <input
            v-model="form.name"
            :disabled="!!editing"
            placeholder="API_KEY"
            aria-label="Name"
            maxlength="64"
            autocomplete="off"
            :class="[input, 'w-44 font-mono uppercase disabled:opacity-60']"
        >
        <input
            v-model="form.value"
            type="password"
            :placeholder="editing ? `New value for ${editing}` : 'value'"
            aria-label="Value"
            autocomplete="new-password"
            :class="[input, 'w-72 max-w-full font-mono']"
        >
      </div>
      <input v-model="form.hosts" placeholder="Hosts it may go to: api.example.com, …" aria-label="Hosts" autocomplete="off" :class="[input, 'w-full font-mono']">
      <div class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        For
        <button
            v-for="project in projects"
            :key="project.id"
            type="button"
            class="rounded-md px-1.5 py-0.5 ring-1 transition-colors"
            :class="form.projects.includes(project.id) ? 'bg-active text-fg ring-faint/60' : 'ring-line hover:bg-hover'"
            :aria-pressed="form.projects.includes(project.id)"
            @click="form.projects = form.projects.includes(project.id) ? form.projects.filter(p => p !== project.id) : [...form.projects, project.id]"
        >{{ project.name }}</button>
        <span class="text-faint" title="Agents say which project a request is for, so this guards against a slip, not a determined agent: the hosts are the limit">{{ form.projects.length ? '(a guard against slips; the hosts are the limit)' : '(none picked: every project)' }}</span>
      </div>
      <div class="flex items-center gap-2">
        <button type="submit" class="h-7 rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="busy || !form.name.trim() || !form.value || !list(form.hosts).length">
          {{ editing ? 'Replace' : 'Add' }}
        </button>
        <button type="button" class="h-7 rounded-md px-2.5 text-xs text-muted ring-1 ring-line hover:bg-hover" @click="editing = null">Cancel</button>
        <span class="text-xs text-faint">The value never shows again, here or to an agent.</span>
      </div>
    </form>
    <div v-else>
      <button type="button" class="rounded-md px-1.5 py-0.5 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg" @click="open()">+ Add a secret</button>
    </div>

    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">
      {{ failed }}
      <template v-if="missingKey"> (in <span class="font-mono">.env</span> for Docker, or <span class="font-mono">NUXT_SECRET_KEY</span> without it)</template>
    </p>
  </div>
</template>
