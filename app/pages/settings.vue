<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// This Orrery's own settings (a project's are on its Settings tab). For now its tint: a colour the
// backgrounds take on, so one Orrery (personal, work) looks unlike another at a glance.
useHead({title: 'App settings · Orrery'})
const {settings, tintColor, save} = useAppSettings()
const {environment} = useRuntimeConfig().public
const failed = ref('')
const custom = ref('#3b82f6')
watch(tintColor, now => {
    if (now) custom.value = now
}, {immediate: true})

async function pick(tint: string | null) {
    failed.value = ''
    try {
        await save({tint})
    } catch (error) {
        failed.value = (error as {data?: {message?: string}}).data?.message ?? "Couldn't save it. Is Orrery running?"
    }
}
</script>

<template>
  <PageHeader>
    <SectionIcon section="settings" class="size-4 text-faint" />
    <h1 class="truncate text-sm font-medium">App settings</h1>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-3xl animate-fade-up flex-col gap-4 px-4 py-8 sm:px-8">
      <section class="flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Background tint</h2>
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
    </div>
  </div>
</template>
