<script setup lang="ts">
// No projects yet: how to add one through the API.
const origin = computed(() => import.meta.client ? location.origin : 'http://localhost:9000')
</script>

<template>
  <div class="mx-auto flex max-w-xl animate-fade-up flex-col gap-5 px-4 py-16">
    <div class="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-accent-300 to-accent-600 shadow-lg shadow-accent-600/30">
      <svg class="size-6 text-zinc-950" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /><circle cx="19.4" cy="8.6" r="1.6" fill="currentColor" stroke="none" /></svg>
    </div>
    <div class="flex flex-col gap-1.5">
      <h1 class="text-lg font-semibold tracking-tight">No projects yet</h1>
      <p class="text-muted">Orrery shows what your apps tell it. Ask Claude in an app's repo to add it through the API, for example:</p>
    </div>
    <pre class="overflow-x-auto rounded-xl bg-well p-4 font-mono text-xs leading-relaxed text-muted ring-1 ring-line">curl -X POST {{ origin }}/api/projects \
  -H 'Content-Type: application/json' \
  -H 'Orrery-Actor: claude' \
  -d '{"name": "mesher", "key": "MSH"}'</pre>
    <p class="text-xs text-faint">Then chunks, issues and comments under <span class="font-mono">/api/projects/mesher/…</span>. The whole API is listed in <span class="font-mono">docs/API.md</span>.</p>
  </div>
</template>
