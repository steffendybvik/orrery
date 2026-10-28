<script setup lang="ts">
// Where the database or its backups are, as App settings shows it (ORR-399). Under Docker that's the folder on this
// computer (`host`), or the Docker volume it's in (`volume`), with the path inside the container small beneath, as
// `/data/orrery.db` reads like a folder at the root of the computer and there's none. Otherwise the path, as it is.
const props = defineProps<{path: string, host?: string, volume?: string}>()
/** iCloud Drive's folder, named, as a path in it is hard to read. */
const icloud = computed(() => !!props.host?.includes('/Mobile Documents/com~apple~CloudDocs'))
/** A path in pieces that each end at a /, so a long one wraps between folders rather than inside a name. */
const parts = (path: string) => path.split(/(?<=\/)/)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-0.5">
    <div v-if="host" class="flex min-w-0 items-start gap-3">
      <div class="min-w-0 flex-1 pt-0.5 text-xs leading-5">
        <span class="text-muted">On this computer: </span>
        <code class="font-mono text-fg [overflow-wrap:anywhere]"><span v-for="(part, i) in parts(host)" :key="i" class="inline-block max-w-full">{{ part }}</span></code>
        <span v-if="icloud" class="text-faint"> (iCloud Drive)</span>
        <slot />
      </div>
      <CopyButton :text="host" />
    </div>
    <div v-else-if="volume" class="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <span class="text-xs text-fg">In the Docker volume <code class="font-mono">{{ volume }}</code></span>
      <span class="text-xs text-faint">(not a folder on your computer)</span>
      <slot />
    </div>
    <div v-else class="flex min-w-0 items-start gap-3">
      <div class="min-w-0 flex-1 pt-0.5 text-xs leading-5">
        <code class="font-mono text-fg [overflow-wrap:anywhere]"><span v-for="(part, i) in parts(path)" :key="i" class="inline-block max-w-full">{{ part }}</span></code>
        <slot />
      </div>
      <CopyButton :text="path" />
    </div>
    <span v-if="host || volume" class="font-mono text-[11px] text-faint [overflow-wrap:anywhere]" :title="`The path inside Docker, as Orrery opens it: ${path}`">inside Docker: {{ path }}</span>
  </div>
</template>
