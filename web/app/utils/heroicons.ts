import type {Component} from 'vue'

// The Heroicons a project can take, by name as heroicons.com writes it: `ShoppingCartIcon` is `shopping-cart`.
// Each is its own file, loaded the first time it's shown, so a page carries only the icons it shows, not the set.
const files = import.meta.glob<{default: Component}>('../../node_modules/@heroicons/vue/16/solid/esm/*Icon.js')
const loaders = new Map(Object.entries(files).map(([path, load]) => [
    // A dash before each word and number, but not inside `3D` or `2X2` (`square-3-stack-3d`, `squares-2x2`).
    path.split('/').pop()!.replace(/Icon\.js$/, '').replace(/([a-z])(?=[0-9A-Z])|([0-9A-Z])(?=[A-Z][a-z])/g, '$1$2-').toLowerCase(),
    load,
]))

export const HEROICONS = [...loaders.keys()].sort()

const loaded = new Map<string, Component>()

/** The icon called `name`, or none for a name Heroicons doesn't have. */
export function heroicon(name: string): Component | undefined {
    const load = loaders.get(name)
    if (!load) return undefined
    if (!loaded.has(name)) loaded.set(name, defineAsyncComponent(() => load().then(module => module.default)))
    return loaded.get(name)
}
