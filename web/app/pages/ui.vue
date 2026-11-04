<script setup lang="ts">
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'
import type {Session} from '#shared/roadmap'
import {TINTS} from '#shared/roadmap'

// The kit in one place (docs/components.md), so a new screen reuses its pieces rather than copying them, and under it the
// atlas of the shared building blocks (ORR-757): each one drawn in its states, with its name. Only under `nuxt dev`: a
// built orrery says Not found here.
if (!import.meta.dev) throw createError({statusCode: 404, statusMessage: 'Not found'})
useHead({title: 'UI kit · orrery'})

const VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'danger-outline', 'danger-ghost', 'success', 'success-outline', 'warning-outline'] as const
const SIZES = ['xs', 'sm', 'md'] as const

const status = ref('todo')
const statusOptions = [
    {value: 'backlog', label: 'Backlog'},
    {value: 'todo', label: 'Todo'},
    {value: 'in-progress', label: 'In progress'},
    {value: 'done', label: 'Done'},
    {value: 'canceled', label: 'Canceled'},
]
const priority = ref('')
const labels = ref(['design'])
const labelOptions = computed(() => [...new Set(['design', 'maintenance', 'security', ...labels.value])].map(l => ({value: l, label: l})))
const view = ref<'list' | 'board'>('list')
const filtered = ref<string[]>([])
const at = ref<{x: number, y: number} | null>(null)
const picked = ref('')
const dialog = ref(false)
const said = ref('')
const confirming = ref(false)
const split = ref(240)

// The atlas's examples: made-up data, enough to draw each piece in its states.
const PULL_STATES = ['conflicting', 'failing', 'behind', 'blocked', 'draft', 'checking', 'ready', 'open', 'merged', 'closed'] as const
const SECTIONS = ['issues', 'roadmap', 'releases', 'docs', 'schedules', 'sessions', 'settings'] as const
const session = (state: Session['state'], more: Partial<Session> = {}) => ({id: state, project: 'greenhouse', name: state, state, since: '', listening: true, ...more}) as Session
const SESSIONS = [
    {label: 'idle', session: session('idle')},
    {label: 'working', session: session('working')},
    {label: 'waiting on you', session: session('waiting')},
    {label: 'starting', session: session('starting')},
    {label: 'not listening', session: session('idle', {listening: false})},
    {label: 'cut off', session: session('idle', {cut_off: {error: 'rate_limit', at: ''}})},
]
const KINDS_SHOWN = [{backlog: 2, todo: 3, started: 2, done: 5, canceled: 0, proposed: 0}, {backlog: 0, todo: 0, started: 0, done: 4, canceled: 0, proposed: 0}]
const COUNTS = {'backlog': 2, 'todo': 3, 'in-progress': 2, 'done': 5}
const MARKDOWN = '### A heading\n\nA paragraph with `code`, **bold** and [a link](https://example.com).\n\n- a list\n- [x] a ticked step\n\n> A quote.'
const tints = Object.keys(TINTS)
</script>

<template>
  <PageHeader>
    <h1 class="truncate text-sm font-medium">UI kit</h1>
    <span class="rounded bg-well px-1.5 py-px font-mono text-[10px] text-faint ring-1 ring-line">dev</span>
  </PageHeader>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-8">
      <section class="flex flex-col gap-3">
        <h2 class="label">UiButton</h2>
        <div v-for="size in SIZES" :key="size" class="flex flex-wrap items-center gap-2">
          <span class="w-8 font-mono text-[11px] text-faint">{{ size }}</span>
          <UiButton v-for="variant in VARIANTS" :key="variant" :variant="variant" :size="size">{{ variant }}</UiButton>
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">PropertyPicker</h2>
        <dl class="grid max-w-md grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2">
          <dt class="text-xs text-muted">Row</dt>
          <dd class="flex min-w-0">
            <PropertyPicker v-model="status" :options="statusOptions" label="Status">
              <StatusIcon :column="status" />
              <span class="truncate">{{ statusOptions.find(o => o.value === status)?.label }}</span>
              <template #option="{option}">
                <StatusIcon :column="option.value" />
                <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
              </template>
            </PropertyPicker>
          </dd>
          <dt class="text-xs text-muted">multiple</dt>
          <dd class="flex min-w-0">
            <PropertyPicker v-model="labels" :options="labelOptions" label="Labels" placeholder="Find or add a label…" multiple creatable>
              <span v-if="labels.length" class="flex min-w-0 flex-wrap items-center gap-1"><LabelChip v-for="l in labels" :key="l" :label="l" /></span>
              <span v-else class="text-faint">No labels</span>
            </PropertyPicker>
          </dd>
        </dl>
        <div class="flex flex-wrap items-center gap-2">
          <PropertyPicker v-model="priority" :options="PRIORITY_OPTIONS" label="Priority" field>
            <PriorityIcon :priority="priority || undefined" />
            <span class="truncate" :class="!priority && 'text-faint'">{{ PRIORITY_OPTIONS.find(o => o.value === priority)?.label }}</span>
          </PropertyPicker>
          <PropertyPicker v-model="status" :options="statusOptions" label="Small status" field small>
            <span class="truncate">{{ statusOptions.find(o => o.value === status)?.label }}</span>
          </PropertyPicker>
          <span class="text-xs text-faint"><code>field</code>, <code>field small</code></span>
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">FilterMenu, Menu and UiContextMenu</h2>
        <div class="flex flex-wrap items-center gap-2">
          <FilterMenu v-model="filtered" label="Urgency" :options="PRIORITY_OPTIONS.filter(o => o.value)">
            <template #option="{value}"><PriorityIcon :priority="value" /></template>
          </FilterMenu>
          <Menu as="div" class="relative">
            <MenuButton as="template"><UiButton size="xs">A menu</UiButton></MenuButton>
            <MenuItems class="menu absolute top-full left-0 z-40 mt-1.5 w-48">
              <MenuItem v-for="name in ['Copy id', 'Open']" :key="name" v-slot="{active}" as="template">
                <UiMenuItem :lit="active" @click="picked = name">{{ name }}</UiMenuItem>
              </MenuItem>
              <MenuItem v-slot="{active}" as="template"><UiMenuItem :lit="active" danger @click="picked = 'Remove'">Remove…</UiMenuItem></MenuItem>
            </MenuItems>
          </Menu>
          <div class="grid h-7 place-items-center rounded-md border border-dashed border-line px-3 text-xs text-muted" @contextmenu.prevent="at = {x: $event.clientX, y: $event.clientY}">
            Right-click here
          </div>
          <span v-if="picked" class="text-xs text-faint" role="status">Last: {{ picked }}</span>
        </div>
        <UiContextMenu :at="at" label="Example menu" width="w-48" @close="at = null">
          <UiMenuItem v-for="name in ['Copy id', 'Open']" :key="name" @click="picked = name; at = null">{{ name }}</UiMenuItem>
          <UiMenuItem danger @click="picked = 'Remove'; at = null">Remove…</UiMenuItem>
        </UiContextMenu>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">SegmentedControl</h2>
        <SegmentedControl v-model="view" :options="[{value: 'list', label: 'List', hint: '1'}, {value: 'board', label: 'Board', hint: '2'}]" class="self-start" />
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">UiSpinner, UiBusy and UiLoading</h2>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span class="inline-flex items-center gap-1.5"><UiSpinner />Adding image…</span>
          <UiButton variant="primary" size="md" disabled><UiBusy busy label="Saving…">Save</UiBusy></UiButton>
          <UiButton disabled><UiBusy busy label="Sending…">Send</UiBusy></UiButton>
          <UiButton><UiBusy label="Sending…">Send</UiBusy></UiButton>
        </div>
        <UiLoading class="rounded-lg ring-1 ring-line" />
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">UiSplitter</h2>
        <div class="flex h-32 rounded-lg text-xs text-muted ring-1 ring-line">
          <div class="shrink-0 p-3" :style="{width: `${split}px`}">{{ split }} px</div>
          <UiSplitter v-model="split" :initial="240" :min="120" :keep="160" label="Resize the example" />
          <div class="min-w-0 flex-1 p-3">Drag the border, or focus it and press ←→</div>
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">UiDialog and UiConfirm</h2>
        <div class="flex flex-wrap items-center gap-2">
          <UiButton @click="dialog = true">Open a dialog</UiButton>
          <UiConfirm v-if="confirming" inline @confirm="confirming = false; picked = 'Removed'" @cancel="confirming = false">Remove this example?</UiConfirm>
          <UiButton v-else variant="danger-outline" @click="confirming = true">Remove…</UiButton>
        </div>
        <UiDialog :open="dialog" label="Example dialog" width="md" @close="dialog = false" @submit="dialog = false; picked = `Submitted ${said}`">
          <h2 class="text-[15px] font-semibold text-fg">Example dialog</h2>
          <p class="text-xs text-muted">Esc or a press outside closes it; ↵ in the field and ⌘↵ submit.</p>
          <input v-model="said" aria-label="Something to say" class="h-8 field">
          <div class="flex items-center gap-2 border-t border-line pt-3">
            <UiButton class="ml-auto" @click="dialog = false">Cancel</UiButton>
            <UiButton type="submit" variant="primary" size="md">Done</UiButton>
          </div>
        </UiDialog>
      </section>

      <header class="flex flex-col gap-1 border-t border-line pt-8">
        <h2 class="text-[15px] font-semibold text-fg">Building blocks</h2>
        <p class="text-xs text-muted">The shared pieces pages are made of (docs/components.md → Shared components), each in its states.</p>
      </header>

      <section class="flex flex-col gap-3" aria-labelledby="atlas-status">
        <h2 id="atlas-status" class="label">StatusIcon, PriorityIcon, ProgressRing and ColumnBar</h2>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span v-for="o in statusOptions" :key="o.value" class="inline-flex items-center gap-1.5"><StatusIcon :column="o.value" />{{ o.label }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span v-for="o in PRIORITY_OPTIONS" :key="o.value" class="inline-flex items-center gap-1.5"><PriorityIcon :priority="o.value || undefined" />{{ o.label }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-4">
          <ProgressRing v-for="(kinds, i) in KINDS_SHOWN" :key="i" :kinds="kinds" />
          <ProgressRing :kinds="KINDS_SHOWN[0]!" bare />
          <ColumnBar :counts="COUNTS" class="w-48" />
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="atlas-chips">
        <h2 id="atlas-chips" class="label">LabelChip, WaitingChip, BlockedChip, PullStateChip and ErrorBadge</h2>
        <div class="flex flex-wrap items-center gap-2">
          <LabelChip v-for="label in ['design', 'security', 'maintenance', 'bug']" :key="label" :label="label" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <WaitingChip asks="decision" />
          <WaitingChip asks="feedback" />
          <WaitingChip asks="decision" :proposal="{choices: 2}" />
          <BlockedChip :blockers="['ORR-270', 'ORR-271']" />
          <ErrorBadge :count="3" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <PullStateChip v-for="state in PULL_STATES" :key="state" :state="state" />
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="atlas-people">
        <h2 id="atlas-people" class="label">PersonAvatar, SessionDot and PresetBadge</h2>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span v-for="name in ['claude', 'hati', 'skoll']" :key="name" class="inline-flex items-center gap-1.5"><PersonAvatar :name="name" />{{ name }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span v-for="s in SESSIONS" :key="s.label" class="inline-flex items-center gap-1.5"><SessionDot :session="s.session" />{{ s.label }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <PresetBadge :preset="{name: 'Release', icon: 'rocket-launch', color: 'violet'}" />
          <PresetBadge :preset="{name: 'Security audit', icon: 'shield-check', color: 'rose'}" />
          <PresetBadge :preset="{name: 'Code review'}" />
          <PresetBadge :preset="{name: 'Release', icon: 'rocket-launch', color: 'violet'}" :size="28" />
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="atlas-icons">
        <h2 id="atlas-icons" class="label">ProjectIcon, SectionIcon and OrreryMark</h2>
        <div class="flex flex-wrap items-center gap-3">
          <ProjectIcon v-for="tint in tints" :key="tint" icon="beaker" :color="tint" class="size-4" />
          <ProjectIcon icon="beaker" class="size-4" />
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span v-for="section in SECTIONS" :key="section" class="inline-flex items-center gap-1.5"><SectionIcon :section="section" />{{ section }}</span>
        </div>
        <div class="flex items-center gap-3 text-fg">
          <OrreryMark class="size-4" />
          <OrreryMark class="size-8" />
        </div>
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="atlas-text">
        <h2 id="atlas-text" class="label">KeyHint, StepMark, InlineText and MarkdownView</h2>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
          <KeyHint>⌘K</KeyHint><KeyHint>⌘↵</KeyHint><KeyHint>Esc</KeyHint><KeyHint>j</KeyHint>
        </div>
        <div class="flex flex-col gap-2 text-xs text-fg">
          <span class="flex items-start gap-2"><StepMark :n="1" done />A step that's done</span>
          <span class="flex items-start gap-2"><StepMark :n="2" :done="false" />A step still to do</span>
        </div>
        <p class="text-xs text-muted"><InlineText text="A line with `code`, **bold** and [a link](https://example.com)." /></p>
        <MarkdownView :source="MARKDOWN" class="rounded-lg p-3 ring-1 ring-line" />
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="atlas-copy">
        <h2 id="atlas-copy" class="label">CopyButton and CopyBlock</h2>
        <div class="flex flex-wrap items-center gap-2">
          <CopyButton text="ORR-271" name="the id" />
          <CopyButton text="ORR-271" name="the id" compact />
        </div>
        <CopyBlock title="Install the launcher" text="curl -fsSL http://localhost:9000/launcher | sh" hint="Run it in a terminal on this machine." />
      </section>

      <section class="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="atlas-styles">
        <h2 id="atlas-styles" class="label">Styles: field, label, glass, tint, unseen-row and waiting-row</h2>
        <div class="flex flex-wrap items-center gap-3">
          <input aria-label="A field" placeholder="field" class="h-8 w-48 field">
          <span class="label">label</span>
          <span class="glass rounded-lg px-3 py-2 text-xs text-fg">glass</span>
          <span class="rounded-lg bg-well px-3 py-2 text-xs text-fg hover:tint">tint, on hover</span>
        </div>
        <div class="flex flex-col gap-1 text-xs text-fg">
          <span class="unseen-row rounded-lg px-2 py-1.5">unseen-row: changed since you looked <span class="unseen-dot" /></span>
          <span class="waiting-row rounded-lg px-2 py-1.5">waiting-row: waiting on your answer</span>
        </div>
      </section>
    </div>
  </div>
</template>
