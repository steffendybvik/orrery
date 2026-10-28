<script setup lang="ts">
// Where the database or its backups are, as App settings shows it (ORR-399). Under Docker that's the folder on this
// computer (`host`), or the Docker volume it's in (`volume`), with the path inside the container small beneath, as
// `/data/orrery.db` reads like a folder at the root of the computer and there's none. Otherwise the path, as it is.
const props = defineProps<{path: string, host?: string, volume?: string}>()
/** iCloud Drive's folder, named, as a path in it is hard to read. */
const icloud = computed(() => !!props.host?.includes('/Mobile Documents/com~apple~CloudDocs'))
</script>

<template>
  <div class="flex min-w-0 flex-col gap-0.5">
    <div v-if="host" class="flex min-w-0 items-center gap-1.5">
      <span class="shrink-0 text-xs text-muted">On this computer:</span>
      <code class="truncate font-mono text-xs text-fg" :title="host">{{ host }}</code><CopyButton :text="host" />
      <span v-if="icloud" class="shrink-0 text-xs text-faint">(iCloud Drive)</span>
      <slot />
    </div>
    <div v-else-if="volume" class="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <span class="text-xs text-fg">In the Docker volume <code class="font-mono">{{ volume }}</code></span>
      <span class="text-xs text-faint">(not a folder on your computer)</span>
      <slot />
    </div>
    <div v-else class="flex min-w-0 items-center gap-1.5">
      <code class="truncate font-mono text-xs text-fg" :title="path">{{ path }}</code><CopyButton :text="path" />
      <slot />
    </div>
    <span v-if="host || volume" class="truncate font-mono text-[11px] text-faint" :title="`The path inside Docker, as Orrery opens it: ${path}`">inside Docker: {{ path }}</span>
  </div>
</template>
