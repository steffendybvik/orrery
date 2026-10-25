<script setup lang="ts">
// A titled block of text to copy as it is: a brief for an agent, a config file, a command.
defineProps<{title: string, text: string, hint?: string}>()
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="flex items-end gap-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 class="text-[13px] font-medium text-fg">{{ title }}</h3>
        <p v-if="hint" class="text-xs text-faint">{{ hint }}</p>
      </div>
      <CopyButton :text="text" />
    </div>
    <pre class="max-h-96 overflow-auto rounded-xl bg-well p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg ring-1 ring-line">{{ text }}</pre>
  </section>
</template>
