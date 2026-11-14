<script setup lang="ts">
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'
import {TINTS} from '#shared/roadmap'

// The workspace this tab is in, at the top of the sidebar (ORR-1108): its colour and name, and a menu of the others
// you're in, each opening in this tab, and New workspace. Another tab stays where it is.
const {list, here, current, load, go, make} = useWorkspaces()
onMounted(() => load())

const making = ref(false)
const name = ref('')
const color = ref<string | null>(null)
const busy = ref(false)
const problem = ref('')

function start() {
    name.value = ''
    color.value = null
    problem.value = ''
    making.value = true
}

async function save() {
    if (!name.value.trim() || busy.value) return
    busy.value = true
    problem.value = ''
    try {
        await make(name.value.trim(), color.value)
    } catch (error) {
        problem.value = (error as {data?: {message?: string}}).data?.message ?? (error as Error).message
        busy.value = false
    }
}
</script>

<template>
  <div class="px-2 pb-2" data-testid="workspace-switcher">
    <Menu as="div" class="relative">
      <MenuButton
          class="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-fg ring-1 ring-line transition-colors hover:bg-hover"
          :title="`This tab is in ${current?.name ?? here}: pick another workspace`"
      >
        <span class="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" :style="{background: workspaceColor(current?.color) ?? 'var(--color-faint, #94a3b8)'}" />
        <span class="min-w-0 flex-1 truncate text-left">{{ current?.name ?? here }}</span>
        <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg>
      </MenuButton>
      <MenuItems class="menu absolute top-full right-0 left-0 z-40 mt-1.5">
        <MenuItem v-for="workspace in list" :key="workspace.id" v-slot="{active}">
          <UiMenuItem :lit="active" :active="workspace.id === here" @click="workspace.id === here || go(workspace.id)">
            <span class="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" :style="{background: workspaceColor(workspace.color) ?? 'var(--color-faint, #94a3b8)'}" />
            <span class="min-w-0 flex-1 truncate">{{ workspace.name }}</span>
            <span v-if="workspace.role === 'owner'" class="text-[11px] text-faint">owner</span>
          </UiMenuItem>
        </MenuItem>
        <div class="my-1 h-px bg-line" />
        <MenuItem v-slot="{active}">
          <UiMenuItem :lit="active" muted @click="start">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New workspace…
          </UiMenuItem>
        </MenuItem>
      </MenuItems>
    </Menu>

    <UiDialog :open="making" name="workspace" label="New workspace" width="md" @close="making = false" @submit="save">
      <div class="space-y-3">
        <p class="text-sm text-muted">A workspace of its own: its projects, statuses, presets, secrets and settings, with you as its owner.</p>
        <label class="block space-y-1">
          <span class="text-xs font-medium text-muted">Name</span>
          <input v-model="name" type="text" maxlength="60" placeholder="Personal, or your team's name" aria-label="Workspace name" class="h-8 w-full field" autofocus data-testid="workspace-name">
        </label>
        <div class="space-y-1">
          <span class="text-xs font-medium text-muted">Colour</span>
          <div class="flex flex-wrap gap-1.5">
            <button
                v-for="(hex, tint) in TINTS"
                :key="tint"
                type="button"
                class="size-6 rounded-full ring-offset-2 ring-offset-panel transition"
                :class="color === tint ? 'ring-2 ring-fg' : 'ring-1 ring-black/10 hover:scale-110'"
                :style="{background: hex}"
                :aria-label="tint"
                :aria-pressed="color === tint"
                @click="color = color === tint ? null : tint"
            />
          </div>
        </div>
        <p v-if="problem" class="text-sm text-rose-700 dark:text-rose-400">{{ problem }}</p>
        <div class="flex justify-end gap-2">
          <UiButton variant="ghost" @click="making = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!name.trim() || busy" @click="save">{{ busy ? 'Making it…' : 'Make it' }}</UiButton>
        </div>
      </div>
    </UiDialog>
  </div>
</template>
