import type {Component} from 'vue'
import * as solid from '@heroicons/vue/16/solid'

// The Heroicons a project can take, by name as heroicons.com writes it: `ShoppingCartIcon` is `shopping-cart`.
const byName = new Map<string, Component>(Object.entries(solid).map(([exported, component]) => [
    // A dash before each word and number, but not inside `3D` or `2X2` (`square-3-stack-3d`, `squares-2x2`).
    exported.replace(/Icon$/, '').replace(/([a-z])(?=[0-9A-Z])|([0-9A-Z])(?=[A-Z][a-z])/g, '$1$2-').toLowerCase(),
    component as Component,
]))

export const HEROICONS = [...byName.keys()]

/** The icon called `name`, or none for a name Heroicons doesn't have. */
export function heroicon(name: string): Component | undefined {
    return byName.get(name)
}
