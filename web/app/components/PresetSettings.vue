<script setup lang="ts">
import {DEFAULT_PRESETS} from '#shared/presets'
import type {Preset, Project} from '#shared/roadmap'

// Presets: saved pieces of context to give a session as you start it, each a name and its text. Without `project`
// they're the orrery's, for sessions on any project; with it, that project's own. Each is a role card: its
// badge, name and first line; clicking one, or New preset, opens it in a dialog to write. orrery ships a few of its own;
// once one's removed, Restore defaults brings it back.
const props = defineProps<{project?: Project}>()
const {forget} = usePresetBadges()

const presets = ref<Preset[]>([])
const list = computed(() => props.project ? `/projects/${encodeURIComponent(props.project.id)}/presets` : '/presets')
async function refresh() {
    const all = await apiFetch<Preset[]>(list.value).catch(() => null)
    if (all) presets.value = all.filter(p => p.project === (props.project?.id ?? null))
}
watch(list, refresh, {immediate: true})

function saved() {
    refresh()
    forget()
}

// The orrery's presets that orrery ships and that were removed.
const removed = computed(() => props.project ? [] : DEFAULT_PRESETS.filter(d => !presets.value.some(p => p.default?.key === d.key)))
const restoring = ref(false)
async function restore() {
    restoring.value = true
    try {
        await apiFetch('/presets/defaults', {method: 'POST'})
        saved()
    } finally {
        restoring.value = false
    }
}

// The preset being written in the dialog: one of these, or 'new'.
const writing = ref<Preset | 'new' | null>(null)
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <li v-for="p in presets" :key="p.id">
        <button
            type="button"
            class="flex size-full min-w-0 items-center gap-3 rounded-xl border border-line p-3 text-left hover:tint dark:bg-panel"
            :aria-label="`Edit ${p.name}`"
            @click="writing = p"
        >
          <PresetBadge :preset="p" :size="32" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[13px] font-medium text-fg">{{ p.name }}</span>
            <span class="truncate text-xs text-muted">{{ firstLine(p.text) }}</span>
          </span>
        </button>
      </li>
      <li>
        <button
            type="button"
            class="flex size-full min-h-[58px] items-center gap-3 rounded-xl border border-dashed border-line p-3 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
            @click="writing = 'new'"
        >
          <span class="grid size-8 place-items-center rounded-[28%] ring-1 ring-inset ring-line">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          New preset
        </button>
      </li>
    </ul>
    <p v-if="removed.length" class="flex items-center gap-2 text-xs text-faint">
      {{ removed.map(d => d.name).join(', ') }} {{ removed.length === 1 ? 'was' : 'were' }} removed.
      <UiButton size="xs" :disabled="restoring" @click="restore">Restore defaults</UiButton>
    </p>
    <PresetDialog :open="writing" :project="project" @close="writing = null" @saved="saved" />
  </div>
</template>
