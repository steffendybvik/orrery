<script setup lang="ts">
// Connect a repo with a click (ORR-708): a launcher opens its machine's folder picker, the owner ticks the projects the
// folder holds here, and the launcher writes the files and opens Claude there. orrery never names the folder, so there's
// nothing to type here: it's chosen on the machine. With no launcher that can, the install line stands in for the button.
import {launcherInstall} from '#shared/connect'
import type {ConnectRequest} from '#shared/connects'

const {ordered} = useProjectOrder()
const install = launcherInstall(useRequestURL().origin)
const pickers = ref<number>()
const request = ref<ConnectRequest>()
const ticked = ref<string[]>([])
const newName = ref('')
const busy = ref(false)
const problem = ref('')

const OPEN = ['asking', 'picking', 'writing']
const asking = computed(() => !!request.value && OPEN.includes(request.value.state))
const already = computed(() => request.value?.projects ?? [])
const canWrite = computed(() => !busy.value && (!!ticked.value.length || !!already.value.length || !!request.value?.every))

async function refresh() {
    const {pickers: count, current} = await apiFetch<{pickers: number, current?: ConnectRequest}>('/connects')
    pickers.value = count
    if (current && !request.value) request.value = current
}
async function follow() {
    if (!request.value) return
    const was = request.value.state
    request.value = await apiFetch<ConnectRequest>(`/connects/${request.value.id}`).catch(() => undefined)
    if (was !== 'picked' && request.value?.state === 'picked') ticked.value = []
}
const timer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
    refresh().catch(() => {
        pickers.value = 0
    })
    // Asked again as launchers come and go; each second while a request is under way, as it waits on someone.
    timer.value = setInterval(() => (asking.value ? follow() : refresh()).catch(() => {}), 1000)
})
onBeforeUnmount(() => clearInterval(timer.value))

async function act(work: () => Promise<void>) {
    busy.value = true
    problem.value = ''
    try {
        await work()
    } catch (error) {
        problem.value = (error as {data?: {message?: string}, message?: string}).data?.message ?? (error as Error).message
    } finally {
        busy.value = false
    }
}
const start = () => act(async () => {
    request.value = await apiFetch<ConnectRequest>('/connects', {method: 'POST', body: {}})
})
const makeProject = () => act(async () => {
    const name = newName.value.trim()
    if (!name) return
    const made = await apiFetch<{id: string}>('/projects', {method: 'POST', body: {name}})
    ticked.value = [...ticked.value, made.id]
    newName.value = ''
})
const write = () => act(async () => {
    const projects = [...new Set([...already.value.filter(id => ordered.value.some(p => p.id === id)), ...ticked.value])]
    if (request.value) request.value = await apiFetch<ConnectRequest>(`/connects/${request.value.id}/write`, {method: 'POST', body: {projects}})
})
function reset() {
    request.value = undefined
    ticked.value = []
    problem.value = ''
}
</script>

<template>
  <section class="flex flex-col gap-4 rounded-2xl bg-accent-500/5 p-5 ring-1 ring-accent-500/25" data-testid="connect-repo">
    <template v-if="!request || request.state === 'canceled'">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-56 flex-1">
          <h3 class="text-[15px] font-semibold">Connect a repo</h3>
          <p class="text-[13px] leading-relaxed text-muted">Choose its folder on your machine and tick its projects. The launcher writes <span class="font-mono text-xs">CLAUDE.md</span>, <span class="font-mono text-xs">.mcp.json</span> and <span class="font-mono text-xs">.claude/settings.json</span>, and opens Claude there.</p>
        </div>
        <UiButton v-if="pickers" variant="primary" :disabled="busy" @click="start">Connect a repo</UiButton>
      </div>
      <p v-if="request?.state === 'canceled'" class="text-[13px] text-muted">Nothing was written: no folder was chosen.</p>
      <template v-if="pickers === 0">
        <CopyBlock title="First, on this machine: install the launcher" hint="Once per machine. On Linux it needs a desktop with zenity or kdialog, and in WSL or with neither, use the line below instead. A launcher that's running updates itself to do this." :text="install" />
      </template>
    </template>

    <div v-else-if="request.state === 'asking' || request.state === 'picking'" class="flex items-center gap-3" aria-live="polite">
      <p class="flex-1 text-[13px] text-fg">
        {{ request.host ? `Choose the repo's folder in the picker on ${request.host}.` : 'Asking your launcher to open a folder picker…' }}
      </p>
    </div>

    <template v-else-if="request.state === 'picked'">
      <div>
        <h3 class="text-[15px] font-semibold">Which projects does <span class="font-mono text-sm">{{ request.folder }}</span> hold?</h3>
        <p v-if="request.every" class="text-[13px] text-muted">Its channel already serves every project here, so there's nothing to tick.</p>
        <p v-else-if="request.host" class="text-[13px] text-muted">On {{ request.host }}.</p>
      </div>
      <div v-if="!request.every" class="flex flex-col gap-1.5">
        <label v-for="p in ordered" :key="p.id" class="flex items-center gap-2 text-[13px]" :class="already.includes(p.id) && 'text-muted'">
          <input v-if="already.includes(p.id)" type="checkbox" checked disabled>
          <input v-else v-model="ticked" type="checkbox" :value="p.id">
          {{ p.name }} <span class="font-mono text-[10px] text-faint">{{ p.key }}</span>
          <span v-if="already.includes(p.id)" class="text-xs text-faint">already connected</span>
        </label>
      </div>
      <form v-if="!request.every" class="flex flex-wrap items-center gap-2" @submit.prevent="makeProject">
        <input v-model="newName" aria-label="A new project's name" placeholder="Or a new project's name" class="h-8 min-w-48 flex-1 rounded-lg bg-well px-3 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
        <UiButton type="submit" :disabled="busy || !newName.trim()">Make it</UiButton>
      </form>
      <div class="flex justify-end gap-2">
        <UiButton variant="ghost" :disabled="busy" @click="reset">Cancel</UiButton>
        <UiButton variant="primary" :disabled="!canWrite" @click="write">Set it up</UiButton>
      </div>
    </template>

    <p v-else-if="request.state === 'writing'" class="text-[13px] text-fg" aria-live="polite">Setting up <span class="font-mono">{{ request.folder }}</span>…</p>

    <template v-else-if="request.state === 'done'">
      <div aria-live="polite">
        <h3 class="text-[15px] font-semibold"><span class="font-mono text-sm">{{ request.folder }}</span> is connected</h3>
        <p class="text-[13px] leading-relaxed text-muted">
          <template v-if="request.written?.length">Wrote {{ request.written.join(', ') }}. Commit them with the repo.</template>
          <template v-else>It already had everything, so nothing changed.</template>
          <template v-if="request.opened"> Claude is open in a terminal there: say yes to the folder and the server, once each, and it's ready.</template>
          <template v-else> Couldn't open a terminal, so start Claude there by hand with the line under Set it up by hand.</template>
        </p>
      </div>
      <div><UiButton @click="reset">Connect another</UiButton></div>
    </template>

    <template v-else>
      <p class="text-[13px] text-red-600 dark:text-red-400" role="alert">{{ request.message ?? 'It failed.' }}</p>
      <div><UiButton @click="reset">Try again</UiButton></div>
    </template>

    <p v-if="problem" class="text-[13px] text-red-600 dark:text-red-400" role="alert">{{ problem }}</p>
  </section>
</template>
