<script setup lang="ts">
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'

// The kit in one place (docs/components.md), so a new screen reuses its pieces rather than copying them. Only
// under `nuxt dev`: a built Orrery says Not found here.
if (!import.meta.dev) throw createError({statusCode: 404, statusMessage: 'Not found'})
useHead({title: 'UI kit · Orrery'})

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
</script>

<template>
  <PageHeader>
    <h1 class="truncate text-sm font-medium">UI kit</h1>
    <span class="rounded bg-well px-1.5 py-px font-mono text-[10px] text-faint ring-1 ring-line">dev</span>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
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

      <section class="flex flex-col gap-3 border-t border-line pt-6">
        <h2 class="label">Showing</h2>
        <div class="flex flex-wrap items-center gap-4 text-xs text-muted">
          <span class="flex items-center gap-1.5"><StatusIcon v-for="o in statusOptions" :key="o.value" :column="o.value" /></span>
          <span class="flex items-center gap-1.5"><PriorityIcon v-for="o in PRIORITY_OPTIONS" :key="o.value" :priority="o.value || undefined" /></span>
          <LabelChip label="design" />
          <PersonAvatar name="claude" />
          <KeyHint>⌘K</KeyHint>
          <CopyButton text="ORR-271" name="the id" />
        </div>
      </section>
    </div>
  </div>
</template>
