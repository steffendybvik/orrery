<script setup lang="ts">
// A project's Heroicon (16px solid, drawn for small sizes), by its name, e.g. `shopping-cart`.
const props = defineProps<{icon: string}>()
const component = computed(() => heroicon(props.icon))
</script>

<template>
  <component :is="component" v-if="component" class="shrink-0" aria-hidden="true" />
</template>
