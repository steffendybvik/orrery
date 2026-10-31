<script setup lang="ts">
// A project's releases, in the order they're arranged in: each with its branch, how far its issues are and whether it
// shipped, opening its page. New release makes one from a version (and the branch its work gathers on).
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const project = computed(() => byId(route.params.project as string))
// Where its releases are made, when it takes them from another project.
const source = computed(() => project.value?.releases_from ? byId(project.value.releases_from) : undefined)

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
        const made = await apiFetch<{version: string}>(`/projects/${encodeURIComponent(project.value.id)}/releases`, {
            method: 'POST', body: {version: version.value.trim(), branch: branch.value.trim() || null},
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

// Releases are dragged to rearrange them (or moved with ⌥↑/⌥↓), where they're made; a line shows where one lands.
// The list moves at once, and the server's order follows.
const arranges = computed(() => project.value?.release_mode === 'own')
const order = ref<string[] | null>(null)
const releases = computed(() => {
    const all = project.value?.releases ?? []
    const arranged = order.value
    if (!arranged) return all
    return [...all].sort((a, b) => arranged.indexOf(a.version) - arranged.indexOf(b.version))
})
watch(() => project.value?.releases, () => order.value = null)
const dragging = ref<string | null>(null)
const dropAt = ref<number | null>(null)
const moveFailed = ref('')
function onDragOver(event: DragEvent, index: number) {
    if (!dragging.value) return
    event.preventDefault()
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropAt.value = event.clientY < box.top + box.height / 2 ? index : index + 1
}
function onDrop() {
    if (dragging.value === null || dropAt.value === null) return
    const from = releases.value.findIndex(r => r.version === dragging.value)
    move(dragging.value, dropAt.value > from ? dropAt.value - 1 : dropAt.value)
    onDragEnd()
}
function onDragEnd() {
    dragging.value = null
    dropAt.value = null
}
function nudge(version: string, by: number, event: KeyboardEvent) {
    const index = releases.value.findIndex(r => r.version === version) + by
    if (index < 0 || index >= releases.value.length) return
    move(version, index)
    nextTick(() => (event.target as HTMLElement).focus())
}
async function move(version: string, index: number) {
    if (!project.value) return
    const versions = releases.value.map(r => r.version).filter(v => v !== version)
    versions.splice(index, 0, version)
    order.value = versions
    moveFailed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(project.value.id)}/releases/${encodeURIComponent(version)}`, {method: 'PATCH', body: {position: index}})
    } catch (error) {
        order.value = null
        moveFailed.value = errorMessage(error)
    }
}

useHead(() => ({title: project.value ? `Releases · ${project.value.name} · orrery` : 'orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
    </template>
    <h1 v-else-if="ready" class="truncate text-sm font-medium">Not found</h1>
  </PageHeader>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <div v-if="project" class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-4 px-4 py-8 sm:px-8">
      <header class="flex items-start gap-3">
        <SectionIcon section="releases" class="mt-0.5 size-4 text-accent-fill" />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Releases</h2>
          <p v-if="project.releases_from" class="text-xs text-muted">
            {{ project.name }} ships in <NuxtLink :to="`/p/${project.releases_from}/releases`" class="text-fg underline underline-offset-2">{{ source?.name ?? project.releases_from }}'s releases</NuxtLink>,
            made there; each counts {{ project.name }}'s issues here. Set an issue's release on its page.
          </p>
          <p v-else-if="project.release_mode === 'none'" class="text-xs text-muted">
            {{ project.name }} has no releases. <NuxtLink :to="`/p/${project.id}/settings#releases`" class="text-fg underline underline-offset-2">Turn them on in Settings</NuxtLink>
            when it ships versions, its own or another project's.
          </p>
          <p v-else class="text-xs text-muted">
            The versions {{ project.name }} ships, and which issues go out in each. Chunks are themes; a release cuts across them.
            Set an issue's release on its page.
          </p>
        </div>
        <UiButton v-if="!making && project.release_mode === 'own'" variant="primary" class="shrink-0" @click="startMaking">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New release
        </UiButton>
      </header>

      <form v-if="making" class="flex flex-col gap-3 rounded-xl border border-line p-4 dark:bg-panel" @submit.prevent="make" @keydown.esc="cancel">
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1 text-xs text-muted">
            Version
            <input ref="versionInput" v-model="version" placeholder="1.0.0-rc.3" spellcheck="false" autocomplete="off" class="h-8 w-44 field font-mono">
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Branch its work gathers on
            <input v-model="branch" placeholder="v1.0.0-rc.3" spellcheck="false" autocomplete="off" class="h-8 w-56 field font-mono" @input="branchTyped = true">
          </label>
          <div class="flex items-center gap-2">
            <UiButton type="submit" variant="primary" size="md" :disabled="busy || !version.trim()"><UiBusy :busy="busy" label="Making…">Make it</UiBusy></UiButton>
            <UiButton size="md" @click="cancel">Cancel</UiButton>
          </div>
        </div>
        <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
      </form>

      <p v-if="moveFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ moveFailed }}</p>
      <ul v-if="releases.length" class="flex flex-col gap-2">
        <li
            v-for="(release, index) in releases"
            :key="release.version"
            class="relative transition-opacity"
            :class="dragging === release.version && 'opacity-40'"
            @dragover="onDragOver($event, index)"
            @drop.prevent="onDrop"
        >
          <span v-if="dropAt === index && dragging" class="pointer-events-none absolute inset-x-2 -top-1.5 h-0.5 rounded-full bg-accent-fill" />
          <span v-if="dropAt === index + 1 && index === releases.length - 1 && dragging" class="pointer-events-none absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full bg-accent-fill" />
          <NuxtLink
              :to="releasePath(project.id, release.version)"
              :draggable="arranges"
              :title="arranges ? 'Drag to rearrange (or ⌥↑ / ⌥↓)' : undefined"
              :class="arranges && 'cursor-grab active:cursor-grabbing'"
              @dragstart="dragging = release.version; $event.dataTransfer?.setData('text/plain', release.version)"
              @dragend="onDragEnd"
              @keydown.alt.up.prevent="arranges && nudge(release.version, -1, $event)"
              @keydown.alt.down.prevent="arranges && nudge(release.version, 1, $event)"
              class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line px-4 py-3 hover:tint dark:bg-panel">
            <span class="font-mono text-[14px] font-medium text-fg">{{ release.version }}</span>
            <ReleaseStateChip :release="release" />
            <span v-if="release.branch" class="font-mono text-xs text-faint">{{ release.branch }}</span>
            <span class="ml-auto flex items-center gap-3 text-xs text-faint">
              <span>{{ release.issues }} {{ release.issues === 1 ? 'issue' : 'issues' }}</span>
              <ProgressRing :kinds="release.kinds" />
            </span>
          </NuxtLink>
        </li>
      </ul>
      <p v-else-if="!making && project.release_mode !== 'none'" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] text-muted">
        <template v-if="project.releases_from">No releases in {{ source?.name ?? project.releases_from }} yet.</template>
        <template v-else>No releases yet. Make one, then set issues for it from their pages.</template>
      </p>
    </div>
    <NotFound v-else-if="ready" reason="It may have been renamed or deleted." to="/mine" back="Go to My issues">No project “{{ route.params.project }}”</NotFound>
    <UiLoading v-else />
  </div>
</template>
