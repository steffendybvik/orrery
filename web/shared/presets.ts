import presets from './presets.json' with {type: 'json'}

// The presets orrery ships (ORR-343): the orrery's own, for sessions on any project, seeded once into each orrery,
// new or upgraded, by their `key`. The owner can change or remove them; Reset to default brings back what's here,
// and Restore defaults the ones removed. A new one added here is seeded on the next start. When a text changes, the
// one it replaces goes in `was`: a saved preset still as it shipped then takes the new text on the next start.
export interface DefaultPreset { key: string, name: string, text: string, icon: string, color: string, was?: string[] }

// The texts live in presets.json, so the Rust API reads the same ones (ORR-949).
export const DEFAULT_PRESETS: DefaultPreset[] = presets

/** Whether a default preset is as orrery ships it. */
export function asShipped(preset: {name: string, text: string, icon: string | null, color: string | null}, shipped: DefaultPreset): boolean {
    return preset.name === shipped.name && preset.text === shipped.text && preset.icon === shipped.icon && preset.color === shipped.color
}
