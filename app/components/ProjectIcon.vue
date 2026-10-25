<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// A project's Heroicon (16px solid, drawn for small sizes), by its name, e.g. `shopping-cart`, in its
// colour (a tint's name or a `#rrggbb`) or, without one, the text's.
const props = defineProps<{icon: string, color?: string | null}>()
const component = computed(() => heroicon(props.icon))
const style = computed(() => props.color ? {color: TINTS[props.color as keyof typeof TINTS] ?? props.color} : undefined)
</script>

<template>
  <component :is="component" v-if="component" class="shrink-0" :style="style" aria-hidden="true" />
</template>
