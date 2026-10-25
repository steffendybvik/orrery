<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// A project's settings: its name, where its code is, its icon in the sidebar and the icon's colour, and deleting
// the project, for good. Its schedules have a page of their own, and so does starting its sessions (Sessions).
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {of} = useSchedules()
const {load} = useOwner()
const project = computed(() => byId(route.params.project as string))

// Its name, saved on Enter or on leaving the field; Esc puts it back.
const name = ref('')
const nameFailed = ref('')
watch(() => project.value?.name, now => {
    name.value = now ?? ''
}, {immediate: true})
async function rename() {
    if (!project.value) return
    const next = name.value.trim()
    if (!next || next === project.value.name) {
        name.value = project.value.name
        return
    }
    nameFailed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body: {name: next}, headers: {'Orrery-Actor': await load()}})
    } catch (error) {
        nameFailed.value = errorMessage(error)
    }
}

// Where its code is, so a release links its branch and PRs; saved like the name.
const repo = ref('')
const repoFailed = ref('')
watch(() => project.value?.repo, now => {
    repo.value = now ?? ''
}, {immediate: true})
async function saveRepo() {
    if (!project.value) return
    const next = repo.value.trim().replace(/\/+$/, '')
    if (next === (project.value.repo ?? '')) return
    repoFailed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body: {repo: next || null}, headers: {'Orrery-Actor': await load()}})
    } catch (error) {
        repoFailed.value = errorMessage(error)
    }
}

// Its icon: any Heroicon, found by name, in a colour (or the text's). The sidebar shows it in place of
// the progress ring.
const search = ref('')
const custom = ref('#3b82f6')
watch(() => project.value?.iconColor, now => {
    if (now?.startsWith('#')) custom.value = now
}, {immediate: true})
const iconFailed = ref('')
const shown = computed(() => {
    const words = search.value.trim().toLowerCase().split(/[\s-]+/).filter(Boolean)
    return HEROICONS.filter(name => words.every(word => name.includes(word)))
})
async function saveIcon(change: {icon?: string | null, iconColor?: string | null}) {
    if (!project.value) return
    iconFailed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(project.value.id)}`, {method: 'PATCH', body: change, headers: {'Orrery-Actor': await load()}})
    } catch (error) {
        iconFailed.value = errorMessage(error)
    }
}

// Deleting it, for good: what goes is spelled out, and the project's id has to be typed to confirm.
const deleting = ref(false)
const typed = ref('')
const removing = ref(false)
const failed = ref('')
const loses = computed(() => {
    if (!project.value) return []
    const issues = allIssues(project.value).length
    const chunks = project.value.board.chunks.filter(c => c.id).length
    const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
    return [n(issues, 'issue'), n(chunks, 'chunk'), n(project.value.docs.length, 'doc'), n(of(project.value.id).length, 'schedule'), 'every comment and signal']
})
watch(() => route.params.project, () => {
    deleting.value = false
    typed.value = ''
})
async function remove() {
    if (!project.value || typed.value !== project.value.id) return
    removing.value = true
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(project.value.id)}`, {method: 'DELETE', headers: {'Orrery-Actor': await load()}})
        router.push('/now')
    } catch (error) {
        failed.value = errorMessage(error, 'delete')
    } finally {
        removing.value = false
    }
}
useHead(() => ({title: project.value ? `Settings · ${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="project" class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-8 px-4 py-8 sm:px-8">
      <section id="name" class="flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Name</h2>
          <p class="text-xs text-muted">How it's shown everywhere. Its id (<span class="font-mono">{{ project.id }}</span>) and issue ids (<span class="font-mono">{{ project.key }}-n</span>) stay as they are, so links and agents keep working.</p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="rename">
          <input
              v-model="name"
              aria-label="Project name"
              spellcheck="false"
              class="h-8 w-72 max-w-full rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              @blur="rename"
              @keydown.esc="name = project.name; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="nameFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ nameFailed }}</span>
        </form>
      </section>

      <section id="repo" class="flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Code</h2>
          <p class="text-xs text-muted">Where {{ project.name }}'s code is, so a release links its branch and the PRs into it.</p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveRepo">
          <input
              v-model="repo"
              type="url"
              aria-label="Where its code is"
              placeholder="https://github.com/you/shop"
              spellcheck="false"
              class="h-8 w-96 max-w-full rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
              @blur="saveRepo"
              @keydown.esc="repo = project.repo ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="repoFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ repoFailed }}</span>
        </form>
      </section>

      <section id="icon" class="flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex items-start gap-3">
          <div class="mt-0.5 grid size-4 place-items-center text-accent-500">
            <ProjectIcon v-if="project.icon" :icon="project.icon" :color="project.iconColor" class="size-4" />
            <ProgressRing v-else :kinds="project.board.kinds" bare :size="14" />
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 class="text-[15px] font-semibold text-fg">Icon</h2>
            <p class="text-xs text-muted">Shows by {{ project.name }} in the sidebar, in place of its progress ring, so you can spot it among the rest. Any of the <a href="https://heroicons.com" target="_blank" rel="noopener" class="underline underline-offset-2 hover:text-fg">Heroicons</a>.</p>
          </div>
          <button v-if="project.icon" type="button" class="h-7 shrink-0 rounded-md px-2.5 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg" @click="saveIcon({icon: null})">Use the ring</button>
        </header>
        <div class="flex flex-col gap-2 rounded-xl border border-line p-3">
          <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Icon colour">
            <span class="mr-1 text-xs text-muted">Colour</span>
            <button
                type="button"
                class="flex h-7 items-center rounded-lg px-2.5 text-xs ring-1 transition-colors"
                :class="!project.iconColor ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
                :aria-pressed="!project.iconColor"
                title="Follows the text, as the sidebar's other icons do"
                @click="saveIcon({iconColor: null})"
            >None</button>
            <button
                v-for="(color, tint) in TINTS"
                :key="tint"
                type="button"
                class="grid size-7 place-items-center rounded-lg ring-1 transition-colors"
                :class="project.iconColor === tint ? 'bg-active ring-faint/60' : 'ring-line hover:bg-hover'"
                :title="tint"
                :aria-label="tint"
                :aria-pressed="project.iconColor === tint"
                @click="saveIcon({iconColor: tint})"
            >
              <span class="size-3.5 rounded-full ring-1 ring-black/10" :style="{background: color}" />
            </button>
            <label
                class="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs ring-1"
                :class="project.iconColor?.startsWith('#') ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line'"
            >
              <input v-model="custom" type="color" aria-label="Custom icon colour" class="size-4 cursor-pointer rounded border-0 bg-transparent p-0" @change="saveIcon({iconColor: custom})">
              Custom
            </label>
          </div>
          <input v-model="search" type="search" placeholder="Find an icon: cart, lock, bolt…" aria-label="Find an icon" spellcheck="false" class="h-8 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
          <div class="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1 overflow-y-auto">
            <button
                v-for="name in shown"
                :key="name"
                type="button"
                class="grid h-9 place-items-center rounded-lg transition-colors"
                :class="project.icon === name ? 'bg-accent-500/15 text-accent-600 ring-1 ring-accent-500/40 dark:text-accent-300' : 'text-muted hover:bg-hover hover:text-fg'"
                :title="name"
                :aria-label="name"
                :aria-pressed="project.icon === name"
                @click="saveIcon({icon: name})"
            >
              <ProjectIcon :icon="name" :color="project.icon === name ? project.iconColor : null" class="size-4" />
            </button>
          </div>
          <p v-if="!shown.length" class="px-1 py-4 text-center text-xs text-faint">No icon called “{{ search }}”.</p>
          <p v-if="iconFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ iconFailed }}</p>
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">What sessions hear</h2>
          <p class="text-xs text-muted">
            What {{ project.name }}'s Claude sessions get when you ask them to focus. Leave a template empty to use the
            Orrery's (on <NuxtLink to="/settings" class="underline underline-offset-2 hover:text-fg">App settings</NuxtLink>).
          </p>
        </header>
        <FocusPrompts :project="project" />
      </section>

      <section id="danger" class="mt-4 flex flex-col gap-3 rounded-xl border border-rose-500/30 p-4">
        <header class="flex items-start gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 class="text-[15px] font-semibold text-rose-600 dark:text-rose-400">Delete this project</h2>
            <p class="text-xs text-muted">Removes {{ project.name }} and everything in it from Orrery.</p>
          </div>
          <button v-if="!deleting" type="button" class="h-7 shrink-0 rounded-md px-2.5 text-xs font-medium text-rose-600 ring-1 ring-rose-500/40 hover:bg-rose-500/10 dark:text-rose-400" @click="deleting = true">Delete project…</button>
        </header>
        <form v-if="deleting" class="flex flex-col gap-3" @submit.prevent="remove" @keydown.esc="deleting = false">
          <div class="rounded-lg bg-rose-500/10 px-3 py-2.5 text-[13px] leading-relaxed text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300">
            <p class="font-semibold">This is permanent. There is no undo.</p>
            <p>Deleting {{ project.name }} throws away {{ loses.join(', ') }}. Claude sessions on it stop getting anything.</p>
            <p class="mt-1 text-xs opacity-80">Only the iCloud backups keep a copy: the daily ones for two weeks, the latest until the next change replaces it.</p>
          </div>
          <label class="flex flex-col gap-1 text-xs text-muted">
            <span>Type <span class="font-mono font-medium text-fg">{{ project.id }}</span> to confirm</span>
            <input v-model="typed" autocomplete="off" spellcheck="false" aria-label="Type the project's id to confirm" class="h-8 w-64 rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line focus:ring-rose-500/50 focus:outline-none">
          </label>
          <div class="flex items-center gap-2">
            <button type="submit" class="h-8 rounded-lg bg-rose-600 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="typed !== project.id || removing">
              {{ removing ? 'Deleting…' : `Delete ${project.name} forever` }}
            </button>
            <button type="button" class="h-8 rounded-lg px-3 text-[13px] text-muted ring-1 ring-line hover:bg-hover hover:text-fg" @click="deleting = false; typed = ''">Cancel</button>
            <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          </div>
        </form>
      </section>
    </div>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
