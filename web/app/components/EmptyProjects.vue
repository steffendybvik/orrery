<script setup lang="ts">
// No projects yet: start one here, or add it through the API.
const origin = computed(() => import.meta.client ? location.origin : 'http://localhost:9000')
const newProject = useState('new-project', () => false)
const command = computed(() => `curl -X POST ${origin.value}/api/projects \\
  -H 'Content-Type: application/json' \\
  -H 'Orrery-Actor: claude' \\
  -d '{"name": "Larder", "key": "LAR"}'`)
</script>

<template>
  <div class="mx-auto flex max-w-xl animate-fade-up flex-col gap-5 px-4 py-16">
    <div class="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-accent-300 to-accent-600 shadow-lg shadow-accent-600/30">
      <OrreryMark class="size-6 text-zinc-950" />
    </div>
    <div class="flex flex-col gap-1.5">
      <h1 class="text-lg font-semibold tracking-tight">No projects yet</h1>
      <p class="text-muted">Orrery shows what your apps tell it. Start one here, or ask Claude in an app's repo to add it through the API.</p>
    </div>
    <button type="button" class="flex h-8 items-center gap-2 self-start rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90" @click="newProject = true">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      New project
    </button>
    <div class="relative">
      <pre class="overflow-x-auto rounded-xl bg-well p-4 pr-24 font-mono text-xs leading-relaxed text-muted ring-1 ring-line">{{ command }}</pre>
      <CopyButton :text="command" class="absolute top-3 right-3" />
    </div>
    <p class="text-xs text-faint">Then chunks, issues and comments under <span class="font-mono">/api/projects/larder/…</span>. The whole API is listed in <span class="font-mono">docs/API.md</span>.</p>
  </div>
</template>
