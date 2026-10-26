<script setup lang="ts">
import {TINTS, issueRef} from '#shared/roadmap'
import type {Heading} from '~/utils/markdown'

// This Orrery's own settings (a project's are on its Settings tab): whose it is, and its tint, a colour
// the backgrounds take on, so one Orrery (personal, work) looks unlike another at a glance.
useHead({title: 'App settings · Orrery'})
const {settings, tintColor, save} = useAppSettings()
const {environment} = useRuntimeConfig().public
const failed = ref('')
// The sections, listed beside them on a wide screen; each section's heading is its title here.
const headings: Heading[] = [
    {id: 'name', text: 'Your name', level: 2},
    {id: 'handle', text: 'Your handle', level: 2},
    {id: 'tracker', text: 'Team tracker', level: 2},
    {id: 'tint', text: 'Background tint', level: 2},
    {id: 'statuses', text: 'Issue statuses', level: 2},
    {id: 'starts', text: 'Starting sessions', level: 2},
    {id: 'sessions', text: 'What sessions hear', level: 2},
    {id: 'presets', text: 'Presets', level: 2},
    {id: 'secrets', text: 'Secrets', level: 2},
]
const title = Object.fromEntries(headings.map(h => [h.id, h.text]))
const scroller = ref<HTMLElement | null>(null)
const custom = ref('#3b82f6')
watch(tintColor, now => {
    if (now) custom.value = now
}, {immediate: true})

// The owner's name, saved on Enter or on leaving the field; Esc puts it back. Their id follows it.
const {owner, load: loadOwner, rename} = useOwner()
onMounted(loadOwner)
const ownerName = ref('')
const ownerFailed = ref('')
watch(() => owner.value?.display, now => {
    ownerName.value = owner.value?.named ? now ?? '' : ''
}, {immediate: true})
async function saveOwner() {
    const next = ownerName.value.trim()
    if (!next || next === owner.value?.display) {
        ownerName.value = owner.value?.named ? owner.value.display : ''
        return
    }
    ownerFailed.value = ''
    try {
        await rename(next)
    } catch (error) {
        ownerFailed.value = errorMessage(error)
    }
}

// Your handle in issues' references, such as your GitHub login: saved like the name; empty uses your id.
const handle = ref('')
const handleFailed = ref('')
watch(() => settings.value.handle, now => {
    handle.value = now ?? ''
}, {immediate: true})
async function saveHandle() {
    const next = handle.value.trim()
    if (next === (settings.value.handle ?? '')) return
    handleFailed.value = ''
    try {
        await save({handle: next || null})
    } catch (error) {
        handleFailed.value = errorMessage(error)
    }
}

// Where the team's tracker shows a task, so an issue's team tasks open there; saved like the name.
const tracker = ref('')
const trackerFailed = ref('')
watch(() => settings.value.tracker, now => {
    tracker.value = now ?? ''
}, {immediate: true})
async function saveTracker() {
    const next = tracker.value.trim()
    if (next === (settings.value.tracker ?? '')) return
    trackerFailed.value = ''
    try {
        await save({tracker: next || null})
    } catch (error) {
        trackerFailed.value = errorMessage(error)
    }
}

async function pick(tint: string | null) {
    failed.value = ''
    try {
        await save({tint})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <PageHeader>
    <SectionIcon section="settings" class="size-4 text-faint" />
    <h1 class="truncate text-sm font-medium">App settings</h1>
  </PageHeader>

  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-6xl animate-fade-up gap-12 px-4 py-8 sm:px-8">
    <div class="flex min-w-0 max-w-3xl flex-1 flex-col gap-8">
      <section id="name" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.name }}</h2>
          <p class="text-xs text-muted">
            You own this Orrery: what you make, no one else can delete. Your <span class="font-mono">Orrery-Actor</span> header is
            <span class="font-mono">{{ owner?.name }}</span>; renaming moves what's yours to the new one.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveOwner">
          <input
              v-model="ownerName"
              aria-label="Your name"
              maxlength="60"
              class="h-8 w-72 max-w-full rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              @blur="saveOwner"
              @keydown.esc="ownerName = owner?.named ? owner.display : ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="ownerFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ ownerFailed }}</span>
        </form>
      </section>

      <section id="handle" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.handle }}</h2>
          <p class="text-xs text-muted">
            Says whose board an issue is on, once colleagues have boards of their own: an issue's reference is
            <span class="font-mono">{{ issueRef(handle.trim() || owner?.name || 'owner', 'DOC-132') }}</span>, for commit bodies and PR descriptions.
            Your GitHub login works well; left empty, it's your id.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveHandle">
          <input
              v-model="handle"
              aria-label="Your handle"
              :placeholder="owner?.name"
              spellcheck="false"
              maxlength="39"
              class="h-8 w-72 max-w-full rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
              @blur="saveHandle"
              @keydown.esc="handle = settings.handle ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="handleFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ handleFailed }}</span>
        </form>
      </section>

      <section id="tracker" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.tracker }}</h2>
          <p class="text-xs text-muted">
            This board is yours; the team's tasks live on its tracker (Linear, Jira). An issue's Team tasks link there:
            give a task's web address with <span class="font-mono">{id}</span> where its id goes.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveTracker">
          <input
              v-model="tracker"
              type="url"
              aria-label="Team tracker"
              placeholder="https://linear.app/your-team/issue/{id}"
              spellcheck="false"
              class="h-8 w-[28rem] max-w-full rounded-lg bg-well px-2.5 font-mono text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
              @blur="saveTracker"
              @keydown.esc="tracker = settings.tracker ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="trackerFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ trackerFailed }}</span>
        </form>
      </section>

      <section id="tint" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.tint }}</h2>
          <p class="text-xs text-muted">
            Colours this Orrery<template v-if="environment"> ({{ environment }})</template> so you can tell it from another at a glance. It's this Orrery's own: each keeps its tint.
          </p>
        </header>
        <div class="flex flex-wrap items-center gap-2">
          <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ring-1 transition-colors"
              :class="!settings.tint ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
              :aria-pressed="!settings.tint"
              @click="pick(null)"
          >None</button>
          <button
              v-for="(color, name) in TINTS"
              :key="name"
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] capitalize ring-1 transition-colors"
              :class="settings.tint === name ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
              :aria-pressed="settings.tint === name"
              @click="pick(name)"
          >
            <span class="size-3.5 rounded-full ring-1 ring-black/10" :style="{background: color}" />
            {{ name }}
          </button>
          <label
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ring-1"
              :class="settings.tint?.startsWith('#') ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line'"
          >
            <input v-model="custom" type="color" aria-label="Custom tint" class="size-5 cursor-pointer rounded border-0 bg-transparent p-0" @change="pick(custom)">
            Custom
          </label>
        </div>
        <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
      </section>

      <section id="statuses" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.statuses }}</h2>
          <p class="text-xs text-muted">
            The columns every project's issues move through. Each belongs to a kind, which is what Orrery and your agents go by:
            add a status to a kind (In review, Blocked) and it counts, shows and signals like the rest of its kind.
          </p>
        </header>
        <StatusSettings />
      </section>

      <section id="starts" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.starts }}</h2>
          <p class="text-xs text-muted">
            Orrery can start Claude sessions itself, with no terminal: when your work finds nobody listening, or when you press
            Start session. It does so for any project whose repo has its launcher installed (see a project's Sessions tab).
          </p>
        </header>
        <SessionStarts />
      </section>

      <section id="sessions" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.sessions }}</h2>
          <p class="text-xs text-muted">
            The message a Claude session gets when you ask it to focus on an issue or work through a chunk, for every project
            (a project can have its own on its Settings tab). Sessions started before a change hear it once they restart.
          </p>
        </header>
        <FocusPrompts />
      </section>

      <section id="presets" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.presets }}</h2>
          <p class="text-xs text-muted">
            Saved context to give a session as you start it, for sessions on any project (a project can have its own on its
            Settings tab). Tick any number in Start session; the session gets their text with every signal, and again after a clear.
          </p>
        </header>
        <PresetSettings />
      </section>

      <section id="secrets" class="scroll-mt-6 flex flex-col gap-3 border-t border-line pt-8">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.secrets }}</h2>
          <p class="text-xs text-muted">
            Keys your agents use to call outside services without ever seeing them. An agent puts
            <span class="font-mono">{{ '{' + '{secret:NAME}' + '}' }}</span> in a request, and Orrery fills it in and sends it, over https, only to the hosts you allow.
            Taking a host off needs nothing more; letting a secret go somewhere new takes its value again.
          </p>
        </header>
        <SecretSettings />
      </section>
    </div>
    <aside class="hidden w-56 shrink-0 xl:block">
      <div class="sticky top-6">
        <DocContents :headings="headings" :root="scroller" />
      </div>
    </aside>
    </div>
  </div>
</template>
