<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// The welcome (ORR-1194): someone new is walked through four short steps before the board, one a screen, each but the
// first skippable, for someone who isn't a developer. Their name (only while the orrery's owner has none, as the first
// open asks it: required, as before), their workspace's name and colour (when it's theirs), connecting this computer's
// agent (the install line, ticked once a launcher connects), and their first project, or the demo. It opens on an
// orrery's first open and for someone whose workspace has no project yet, until they finish or skip it in this browser,
// and never in a workspace they've just made from the switcher.
const {named, rename} = useOwner()
const {settings, save: saveSettings} = useAppSettings()
const {projects, ready, launchers} = useRoadmaps()
const {current: workspace, load: loadWorkspaces} = useWorkspaces()
const demo = useDemoProject()
onMounted(() => loadWorkspaces())

/** Kept per workspace in this browser: once finished or skipped, it doesn't come back. */
const doneKey = computed(() => welcomeKey(workspace.value?.id ?? 'default'))
const finished = ref(false)
onMounted(() => {
    finished.value = localStorage.getItem(doneKey.value) === 'done'
})
watch(doneKey, key => {
    finished.value = localStorage.getItem(key) === 'done'
})

type Step = 'name' | 'workspace' | 'agent' | 'project'
// The steps there are, and those answered or skipped: the name stays listed once given, so the count under them doesn't
// change as it's answered, and the workspace's comes in once it's known to be theirs.
const answered = ref(new Set<Step>())
const steps = computed<Step[]>(() => [
    ...!named.value || answered.value.has('name') ? ['name' as const] : [],
    ...workspace.value?.role === 'owner' ? ['workspace' as const] : [],
    'agent', 'project',
])
const step = computed(() => steps.value.find(s => !answered.value.has(s)))
const at = computed(() => Math.max(0, steps.value.indexOf(step.value ?? 'project')))
const open = computed(() => !named.value || (ready.value && !finished.value && !projects.value.length && !!step.value))

/** Answers `which` (the step on screen when it was sent): saving the name drops it from `steps` before this runs, so
 *  the step on screen by then is already the next one. */
function next(which = step.value) {
    if (!which) return
    answered.value = new Set([...answered.value, which])
    if (!step.value) finish()
}
function finish() {
    localStorage.setItem(doneKey.value, 'done')
    finished.value = true
}

// Step 1: your name, as the first open always asked, and whether you're a developer (ORR-579).
const display = ref('')
const developer = ref(true)
const saving = ref(false)
const failed = ref('')
/** As the server makes it: `Sköll Fenrisson` → `skoll_fenrisson`. */
const id = computed(() => display.value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))

async function saveName() {
    if (!id.value || id.value === 'agent' || saving.value) return
    saving.value = true
    failed.value = ''
    try {
        await rename(display.value.trim())
        if (!developer.value && settings.value.advanced) await saveSettings({advanced: false})
        next('name')
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}

// Step 2: the workspace's name and colour, its owner's to set; `Default` is offered as Personal.
const spaceName = ref('')
const spaceColor = ref<string | null>(null)
watch(workspace, now => {
    if (!now || spaceName.value) return
    spaceName.value = now.name === 'Default' ? 'Personal' : now.name
    spaceColor.value = now.color
}, {immediate: true})

async function saveWorkspace() {
    if (!workspace.value || !spaceName.value.trim() || saving.value) return
    saving.value = true
    failed.value = ''
    try {
        const changed = await apiFetch<Workspace>(`/workspaces/${encodeURIComponent(workspace.value.id)}`, {method: 'PATCH', body: {name: spaceName.value.trim(), color: spaceColor.value}})
        Object.assign(workspace.value, changed)
        if (spaceColor.value !== settings.value.tint) await saveSettings({tint: spaceColor.value})
        next('workspace')
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}

// Step 3: the line that connects this computer's agent; it ticks once a launcher is connected.
const machineLine = useMachineLine()
const connected = computed(() => Object.values(launchers.value).some(count => count > 0))

// Step 4: a first project, or the demo, and then its board.
const projectName = ref('')
const router = useRouter()
async function makeProject() {
    if (!projectName.value.trim() || saving.value) return
    saving.value = true
    failed.value = ''
    try {
        const made = await apiFetch<{id: string}>('/projects', {method: 'POST', body: {name: projectName.value.trim()}})
        finish()
        router.push(`/p/${made.id}`)
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}
async function tryDemo() {
    const made = await demo.make()
    finish()
    if (made) router.push(`/p/${made}`)
}

function submit() {
    if (step.value === 'name') saveName()
    else if (step.value === 'workspace') saveWorkspace()
    else if (step.value === 'project') makeProject()
    else next()
}
</script>

<template>
  <UiDialog :open="open" name="welcome" label="Welcome" width="md" :required="step === 'name'" data-testid="welcome" @close="finish" @submit="submit">
    <div class="flex items-center gap-1.5" aria-hidden="true">
      <span v-for="(_, i) in steps" :key="i" class="h-1 flex-1 rounded-full" :class="i <= at ? 'bg-accent-fill' : 'bg-line'" />
    </div>
    <p class="text-xs text-faint">Step {{ at + 1 }} of {{ steps.length }}</p>

    <template v-if="step === 'name'">
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Welcome! What's your name?</h2>
        <p class="text-xs text-muted">How people and agents see you here. You can change it later in Settings.</p>
      </div>
      <input v-model="display" placeholder="Your name" aria-label="Your name" maxlength="60" autofocus class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-[13px] font-medium text-fg">Are you a developer?</legend>
        <div class="flex gap-2">
          <label
              v-for="{value, label, note} in [{value: true, label: 'Yes', note: 'Show the pages for looking into problems'}, {value: false, label: 'No', note: 'Keep them out of the sidebar'}]"
              :key="label"
              class="flex flex-1 cursor-pointer items-start gap-2 rounded-lg p-2 ring-1 hover:bg-hover"
              :class="developer === value ? 'ring-accent-500/50' : 'ring-line'"
          >
            <input v-model="developer" type="radio" name="developer" :value="value" class="mt-0.5 accent-accent-fill">
            <span class="flex flex-col gap-0.5">
              <span class="text-[13px] font-medium text-fg">{{ label }}</span>
              <span class="text-xs text-muted">{{ note }}</span>
            </span>
          </label>
        </div>
      </fieldset>
      <p v-if="id === 'agent'" class="text-xs text-rose-700 dark:text-rose-400">"agent" is taken: pick another name.</p>
    </template>

    <template v-else-if="step === 'workspace'">
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Name your workspace</h2>
        <p class="text-xs text-muted">Your projects live in it. Call it Personal, or your team's name, and pick a colour you'll know it by.</p>
      </div>
      <input v-model="spaceName" placeholder="Personal" aria-label="Workspace name" maxlength="60" autofocus class="h-9 w-full field" data-testid="welcome-workspace">
      <div class="flex flex-wrap gap-1.5">
        <button
            v-for="(hex, tint) in TINTS"
            :key="tint"
            type="button"
            class="size-7 rounded-full ring-offset-2 ring-offset-panel transition"
            :class="spaceColor === tint ? 'ring-2 ring-fg' : 'ring-1 ring-black/10 hover:scale-110'"
            :style="{background: hex}"
            :aria-label="tint"
            :aria-pressed="spaceColor === tint"
            @click="spaceColor = spaceColor === tint ? null : tint"
        />
      </div>
    </template>

    <template v-else-if="step === 'agent'">
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Connect your AI agent</h2>
        <p class="text-xs text-muted">So Claude on this computer can pick up work from orrery. Open the Terminal app, paste this and press Return. This step ticks itself off once it's connected.</p>
      </div>
      <CopyBlock title="Paste into the Terminal app" :text="machineLine" />
      <p class="flex items-center gap-2 text-[13px]" :class="connected ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted'" data-testid="welcome-agent-state">
        <UiSpinner v-if="!connected" />
        <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7" /></svg>
        {{ connected ? 'Connected' : 'Waiting for this computer…' }}
      </p>
    </template>

    <template v-else-if="step === 'project'">
      <div class="flex flex-col gap-1">
        <h2 class="text-[15px] font-semibold text-fg">Make your first project</h2>
        <p class="text-xs text-muted">One for each app, or anything you're working on. Or look around a demo first.</p>
      </div>
      <input v-model="projectName" placeholder="Project name, such as Website" aria-label="Project name" maxlength="60" autofocus class="h-9 w-full field" data-testid="welcome-project">
      <UiButton size="md" class="self-start" :disabled="demo.making.value" @click="tryDemo">
        <UiBusy :busy="demo.making.value" label="Making the demo…">Try a demo project instead</UiBusy>
      </UiButton>
    </template>

    <div class="flex items-center gap-2 border-t border-line pt-3">
      <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
      <UiButton v-if="step !== 'name' && !(step === 'agent' && connected)" variant="ghost" size="md" class="ml-auto" @click="step === 'project' ? finish() : next(step)">
        {{ step === 'project' ? 'Skip for now' : 'Skip' }}
      </UiButton>
      <UiButton
          type="submit"
          variant="primary"
          size="md"
          :class="(step === 'name' || (step === 'agent' && connected)) && 'ml-auto'"
          :disabled="saving || (step === 'name' && (!id || id === 'agent')) || (step === 'workspace' && !spaceName.trim()) || (step === 'project' && !projectName.trim())"
          data-testid="welcome-next"
      >
        <UiBusy :busy="saving" label="Saving…">{{ step === 'project' ? 'Make it' : step === 'agent' ? (connected ? 'Continue' : 'Continue without it') : 'Continue' }}</UiBusy>
      </UiButton>
    </div>
  </UiDialog>
</template>
