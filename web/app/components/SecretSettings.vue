<script setup lang="ts">
import type {Secret} from '#shared/roadmap'

// The orrery's secrets on App settings: each by name, the last 4 characters of its value, the hosts it may
// go to, the projects that may use it, and its last use. Set or replace one with its value (which never
// comes back); take a host off without it, since that only narrows where it goes. Saved as the owner.
const {secrets, load: loadSecrets} = useSecretList()
const {who} = useOwner()
const {projects, byId} = useRoadmaps()
const failed = ref('')
const busy = ref(false)
const missingKey = ref(false)
onMounted(() => loadSecrets().catch(error => failed.value = errorMessage(error)))

async function call(name: string, method: 'PUT' | 'PATCH' | 'DELETE', body?: Record<string, unknown>) {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/secrets/${encodeURIComponent(name)}`, {method: method as 'PUT', body})
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
/** The ready-made GITHUB_TOKEN's form: its name and host fixed, only the token to paste. */
const preset = ref(false)
function open(secret?: Secret) {
    editing.value = secret?.name ?? ''
    preset.value = false
    Object.assign(form, {name: secret?.name ?? '', value: '', hosts: secret?.hosts.join(', ') ?? '', projects: [...secret?.projects ?? []]})
}
const list = (text: string) => text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
// orrery reads pull requests with a GITHUB_TOKEN only when it may go to api.github.com (ORR-632): one saved without that
// host would be ignored, so the form says so while the value is still in it, and adds the host on a click.
const GITHUB = 'GITHUB_TOKEN'
const GITHUB_HOST = 'api.github.com'
const githubForm = computed(() => form.name.trim().toUpperCase() === GITHUB)
const githubUnused = computed(() => githubForm.value && !list(form.hosts).includes(GITHUB_HOST))
const addGithubHost = () => form.hosts = [...list(form.hosts), GITHUB_HOST].join(', ')
// Until one is set, GITHUB_TOKEN is listed ready-made, Not set, so it's plain what it's for and Set needs only the
// token; once set, its last use says whether GitHub took it.
const githubSet = computed(() => secrets.value.some(s => s.name === GITHUB))
function openGithub() {
    open()
    preset.value = true
    Object.assign(form, {name: GITHUB, hosts: GITHUB_HOST})
}
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
const projectName = (id: string) => byId(id)?.name ?? id

const input = 'h-7 rounded-md bg-well px-2 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-col rounded-xl bg-well/50 p-2 ring-1 ring-line">
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
                :title="secret.last_used ? `${secret.last_used.method} ${secret.last_used.host}${secret.last_used.path} by ${who(secret.last_used.created_by)}: ${secret.last_used.status ?? secret.last_used.error}` : undefined"
            >
              <template v-if="secret.name === GITHUB && secret.last_used?.status === 401">
                <span class="text-rose-700 dark:text-rose-400">GitHub turned it down {{ ago(secret.last_used.created_at) }}: replace it with one that works</span>
              </template>
              <template v-else-if="secret.last_used">
                used {{ ago(secret.last_used.created_at) }}
                <span :class="secret.last_used.status && secret.last_used.status < 400 ? '' : 'text-rose-700 dark:text-rose-400'">· {{ secret.last_used.status ?? 'failed' }}</span>
              </template>
              <template v-else>never used</template>
            </span>
            <UiButton variant="ghost" size="xs" @click="open(secret)">Replace</UiButton>
            <UiButton variant="ghost" size="xs" square :disabled="busy" :aria-label="`Delete ${secret.name}`" @click="removing = secret.name">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </UiButton>
          </span>
        </div>
        <div v-if="removing === secret.name" class="flex flex-wrap items-center gap-2 px-1.5 py-1.5 text-xs text-muted">
          Delete {{ secret.name }}? Agents using it get a 404; its uses stay on record.
          <UiButton variant="danger" :disabled="busy" @click="remove(secret)">Delete</UiButton>
          <UiButton @click="removing = null">Cancel</UiButton>
        </div>
      </div>
      <div v-if="!githubSet" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1.5 py-1">
        <span class="font-mono text-[13px] text-muted">{{ GITHUB }}</span>
        <span class="text-xs text-faint">Not set: orrery uses it to read pull requests on private repos, and where each stands</span>
        <UiButton size="xs" class="ml-auto" @click="openGithub">Set</UiButton>
      </div>
    </div>

    <form v-if="editing !== null" class="flex flex-col gap-2 rounded-xl bg-well/50 p-3 ring-1 ring-line" @submit.prevent="save">
      <div class="flex flex-wrap items-center gap-2">
        <input
            v-model="form.name"
            :disabled="!!editing || preset"
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
      <input v-model="form.hosts" placeholder="Hosts it may go to: api.example.com, …" aria-label="Hosts" autocomplete="off" :readonly="preset" :class="[input, 'w-full font-mono read-only:opacity-60']">
      <p v-if="githubForm" class="text-xs text-muted">
        A fine-grained token with <i>Pull requests: Read-only</i> on the repos, or a classic one with <span class="font-mono">repo</span>.
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="text-accent-700 hover:underline dark:text-accent-400">Make one on GitHub</a>
      </p>
      <p v-if="githubUnused" class="flex flex-wrap items-center gap-2 text-xs text-amber-800 dark:text-amber-400">
        <span>orrery reads pull requests with a GITHUB_TOKEN only when it may go to <span class="font-mono">{{ GITHUB_HOST }}</span>, so without it this one won't be used there.</span>
        <UiButton size="xs" @click="addGithubHost">Add {{ GITHUB_HOST }}</UiButton>
      </p>
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
        <UiButton type="submit" variant="primary" :disabled="busy || !form.name.trim() || !form.value || !list(form.hosts).length">
          {{ editing ? 'Replace' : 'Add' }}
        </UiButton>
        <UiButton @click="editing = null">Cancel</UiButton>
        <span class="text-xs text-faint">The value never shows again, here or to an agent.</span>
      </div>
    </form>
    <div v-else>
      <UiButton size="xs" @click="open()">+ Add a secret</UiButton>
    </div>

    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">
      {{ failed }}
      <template v-if="missingKey"> (in <span class="font-mono">.env</span> for Docker, or <span class="font-mono">NUXT_SECRET_KEY</span> without it)</template>
    </p>
  </div>
</template>
