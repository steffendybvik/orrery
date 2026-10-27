<script setup lang="ts">
import type {Choice, Issue, Picks} from '#shared/roadmap'
import {liveChoices} from '#shared/roadmap'

// A proposal's choices, on its decision panel: each question with its options, one to pick (radios) or any
// (ticks), the agent's recommendation ticked to start with and marked. What you tick differently shows as
// your call. A choice that goes further down an option sits under it, and counts only while it's ticked.
// Explore asks the agent to go further down an option instead of deciding now.
const props = defineProps<{issue: Issue}>()
const picks = defineModel<Picks>({required: true})
const emit = defineEmits<{explore: [choice: Choice, option: string]}>()

/** The choices that count for the picks so far: the top ones, and those down a ticked option. */
const live = computed(() => liveChoices(props.issue.choices, picks.value))
const depth = (choice: Choice): number => {
    const {from} = choice
    const parent = from && props.issue.choices.find(c => c.key === from.choice)
    return parent ? depth(parent) + 1 : 0
}
const ticked = (choice: Choice, option: string) => (picks.value[choice.key] ?? []).includes(option)
const yours = (choice: Choice, option: string) => ticked(choice, option) !== choice.recommended.includes(option)

function toggle(choice: Choice, option: string) {
    const now = picks.value[choice.key] ?? []
    picks.value = {...picks.value, [choice.key]: choice.pick === 'one' ? [option] : now.includes(option) ? now.filter(o => o !== option) : [...now, option]}
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <fieldset
        v-for="choice in live"
        :key="choice.key"
        class="flex flex-col gap-1.5"
        :class="depth(choice) ? 'ml-4 border-l-2 border-line pl-3' : ''"
        :style="depth(choice) > 1 ? {marginLeft: `${depth(choice)}rem`} : undefined"
    >
      <legend class="mb-1 flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium text-fg">
        <span v-if="choice.from" class="text-xs font-normal text-faint">Going further down {{ choice.from.option }} ·</span>
        {{ choice.question }}
        <span class="text-[11px] font-normal text-faint">{{ choice.pick === 'one' ? 'pick one' : 'pick any' }}</span>
      </legend>
      <label
          v-for="option in choice.options"
          :key="option.key"
          class="group flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 ring-1 transition-colors hover:bg-hover"
          :class="ticked(choice, option.key) ? 'bg-panel ring-accent-500/40' : 'ring-line'"
      >
        <input
            :type="choice.pick === 'one' ? 'radio' : 'checkbox'"
            :name="`${issue.id}-${choice.key}`"
            :checked="ticked(choice, option.key)"
            class="mt-1 size-3.5 shrink-0 accent-accent-500"
            @change="toggle(choice, option.key)"
        >
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex flex-wrap items-baseline gap-x-2">
            <span class="font-mono text-xs text-faint">{{ option.key }}</span>
            <span class="text-[13px] text-fg">{{ option.title }}</span>
            <span v-if="choice.recommended.includes(option.key)" class="text-[11px] text-emerald-600 dark:text-emerald-400">recommended</span>
            <span v-if="yours(choice, option.key)" class="text-[11px] text-accent-600 dark:text-accent-400">your call</span>
          </span>
          <span v-if="option.body" class="text-xs leading-5 text-muted"><InlineText :text="option.body" /></span>
        </span>
        <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-faint opacity-0 ring-1 ring-line group-hover:opacity-100 hover:text-fg focus:opacity-100"
            :title="`Ask the agent to go further down ${option.key} before you decide`"
            @click.prevent="emit('explore', choice, option.key)"
        >Explore</button>
      </label>
    </fieldset>
  </div>
</template>
