<script setup lang="ts">
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'
import {BookmarkIcon} from '@heroicons/vue/16/solid'
import type {Preset, Session} from '#shared/roadmap'

// The owner's own words to one listening session, through its channel on `project`: it reads them as a message
// to it alone, nothing typed into its terminal. Enter sends, Shift-Enter starts a new line; Send shows once there's
// something to send. A preset (one its sessions can have) fills the box to tweak before sending, and the message is
// labelled by its name; emptying the box lets it go.
const props = defineProps<{session: Session, project: string}>()
const {load} = useOwner()
const text = ref('')
const presets = ref<Preset[]>([])
const from = ref<Preset | null>(null)
watch(text, now => now.trim() || (from.value = null))

/** The presets, asked for as the menu opens, so one made since the page loaded is there. */
async function loadPresets() {
    presets.value = await $fetch<Preset[]>(`/api/projects/${encodeURIComponent(props.project)}/presets`).catch(() => presets.value)
}

function use(preset: Preset) {
    text.value = preset.text
    from.value = preset
}
const busy = ref(false)
const sent = ref(false)
const failed = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(timer))

async function send() {
    const message = text.value.trim()
    if (!message || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.project)}/sessions/${encodeURIComponent(props.session.id)}/message`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {text: message, ...from.value ? {preset: from.value.id} : {}},
        })
        text.value = ''
        from.value = null
        sent.value = true
        clearTimeout(timer)
        timer = setTimeout(() => sent.value = false, 2000)
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <form class="flex flex-col gap-1" @submit.prevent="send">
    <div class="flex items-end gap-2">
      <Menu as="div" class="relative">
        <MenuButton as="template">
          <UiButton variant="ghost" square :aria-label="from ? `From the preset ${from.name}` : 'Pick a preset'" :title="from ? `From the preset ${from.name}` : 'Pick a preset'" @click="loadPresets">
            <PresetBadge v-if="from" :preset="from" :size="18" />
            <BookmarkIcon v-else class="size-4" />
          </UiButton>
        </MenuButton>
        <MenuItems class="menu absolute bottom-full left-0 z-40 mb-1.5 w-64">
          <MenuItem v-for="preset in presets" :key="preset.id" v-slot="{active}" as="template">
            <UiMenuItem :lit="active" :active="from?.id === preset.id" @click="use(preset)">
              <PresetBadge :preset="preset" :size="18" />
              <span class="truncate">{{ preset.name }}</span>
            </UiMenuItem>
          </MenuItem>
          <p v-if="!presets.length" class="px-2 py-1.5 text-xs text-faint">
            No presets yet: make them under <NuxtLink to="/sessions#presets" class="text-accent-600 hover:underline dark:text-accent-400">Presets</NuxtLink>.
          </p>
        </MenuItems>
      </Menu>
      <textarea
          v-model="text"
          rows="1"
          :aria-label="`Message ${session.name}`"
          :placeholder="`Message ${session.name}…`"
          title="Only it hears this. Enter sends; Shift-Enter for a new line"
          class="field-sizing-content max-h-40 min-h-7 flex-1 resize-none rounded-lg bg-well px-3 py-1 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
          @keydown.enter.exact.prevent="send"
      />
      <button
          v-if="text.trim() || busy || sent"
          type="submit"
          class="h-7 shrink-0 rounded-lg px-3 text-xs font-medium text-accent-600 ring-1 ring-accent-500/40 hover:bg-accent-500/10 disabled:opacity-40 dark:text-accent-400"
          :disabled="!text.trim() || busy"
      >
        {{ busy ? 'Sending…' : sent ? 'Sent' : 'Send' }}
      </button>
    </div>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </form>
</template>
