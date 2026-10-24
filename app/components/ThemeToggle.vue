<script setup lang="ts">
import type {Theme} from '~/composables/useTheme'

const {theme, set, apply} = useTheme()
const options: {value: Theme, label: string}[] = [{value: 'system', label: 'Auto'}, {value: 'light', label: 'Light'}, {value: 'dark', label: 'Dark'}]
const choice = computed({get: () => theme.value, set})

// Follows the system while on Auto.
let media: MediaQueryList | null = null
onMounted(() => {
    media = matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', apply)
})
onBeforeUnmount(() => media?.removeEventListener('change', apply))
</script>

<template>
  <SegmentedControl v-model="choice" :options="options" class="[&_button]:flex-1 [&_button]:justify-center [&_button]:px-1.5" />
</template>
