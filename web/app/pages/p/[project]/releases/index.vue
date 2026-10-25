<script setup lang="ts">
// A project's releases, those being prepared first: each with its branch, how far its issues are and whether it shipped,
// opening its page. New release makes one from a version (and the branch its work gathers on).
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {load} = useOwner()
const project = computed(() => byId(route.params.project as string))

const making = ref(false)
const version = ref('')
const branch = ref('')
const busy = ref(false)
const failed = ref('')
const versionInput = ref<HTMLInputElement | null>(null)
function startMaking() {
    making.value = true
    failed.value = ''
    nextTick(() => versionInput.value?.focus())
}
// The branch follows the version (`v1.0.0`) until it's typed in.
const branchTyped = ref(false)
watch(version, next => {
    if (!branchTyped.value) branch.value = next.trim() ? `v${next.trim()}` : ''
})
async function make() {
    if (!project.value || !version.value.trim()) return
    busy.value = true
    failed.value = ''
    try {
        const made = await $fetch<{version: string}>(`/api/projects/${encodeURIComponent(project.value.id)}/releases`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {version: version.value.trim(), branch: branch.value.trim() || null},
        })
        router.push(releasePath(project.value.id, made.version))
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
function cancel() {
    making.value = false
    version.value = branch.value = ''
    branchTyped.value = false
}

useHead(() => ({title: project.value ? `Releases · ${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="project" class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-4 px-4 py-8 sm:px-8">
      <header class="flex items-start gap-3">
        <SectionIcon section="releases" class="mt-0.5 size-4 text-accent-500" />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Releases</h2>
          <p class="text-xs text-muted">
            The versions {{ project.name }} ships, and which issues go out in each. Chunks are themes; a release cuts across them.
            Set an issue's release on its page.
          </p>
        </div>
        <button v-if="!making" type="button" class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-xs font-medium whitespace-nowrap text-white hover:opacity-90" @click="startMaking">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New release
        </button>
      </header>

      <form v-if="making" class="flex flex-col gap-3 rounded-xl border border-line p-4" @submit.prevent="make" @keydown.esc="cancel">
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1 text-xs text-muted">
            Version
            <input ref="versionInput" v-model="version" placeholder="1.0.0-rc.3" spellcheck="false" autocomplete="off" class="h-8 w-44 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Branch its work gathers on
            <input v-model="branch" placeholder="v1.0.0-rc.3" spellcheck="false" autocomplete="off" class="h-8 w-56 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none" @input="branchTyped = true">
          </label>
          <div class="flex items-center gap-2">
            <button type="submit" class="h-8 rounded-lg bg-accent-500 px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="busy || !version.trim()">{{ busy ? 'Making…' : 'Make it' }}</button>
            <button type="button" class="h-8 rounded-lg px-3 text-[13px] text-muted ring-1 ring-line hover:bg-hover hover:text-fg" @click="cancel">Cancel</button>
          </div>
        </div>
        <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
      </form>

      <ul v-if="project.releases.length" class="flex flex-col gap-2">
        <li v-for="release in project.releases" :key="release.version">
          <NuxtLink :to="releasePath(project.id, release.version)" class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line px-4 py-3 transition-colors hover:bg-hover">
            <span class="font-mono text-[14px] font-medium text-fg">{{ release.version }}</span>
            <span
                class="rounded-full px-2 py-px text-[11px] font-medium ring-1"
                :class="release.shippedOn ? 'text-emerald-700 ring-emerald-500/30 dark:text-emerald-300' : 'text-accent-600 ring-accent-500/30 dark:text-accent-300'"
            >{{ release.shippedOn ? `Shipped ${release.shippedOn}` : 'Preparing' }}</span>
            <span v-if="release.branch" class="font-mono text-xs text-faint">{{ release.branch }}</span>
            <span class="ml-auto flex items-center gap-3 text-xs text-faint">
              <span>{{ release.issues }} {{ release.issues === 1 ? 'issue' : 'issues' }}</span>
              <ProgressRing :kinds="release.kinds" />
            </span>
          </NuxtLink>
        </li>
      </ul>
      <p v-else-if="!making" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] text-muted">
        No releases yet. Make one, then set issues for it from their pages.
      </p>
    </div>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
