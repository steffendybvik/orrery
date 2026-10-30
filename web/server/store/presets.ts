// Presets: the context a session can be started with, the orrery's or a project's. Those orrery ships
// (shared/presets.ts) are seeded once each, can be reset to what it ships, and restored once removed.
import {DEFAULT_PRESETS, asShipped} from '#shared/presets'
import type {Preset} from '#shared/roadmap'
import {badRequest, checkInput, conflict, notFound} from '../utils/input'
import type {PresetRow} from './schema'
import {AGENT, PRESET_FIELDS, nullable, presetInput, stamp} from './schema'
import {ProjectStore} from './projects'
import {known} from '#shared/known'
import {ownerOnly} from '../utils/permission'

export abstract class PresetStore extends ProjectStore {
    /** The orrery's presets, by name; with a project, those a session on it can have: the orrery's, then its own. */
    async presets(project?: string): Promise<Preset[]> {
        if (project) await this.projectRow(project)
        return (await this.all<PresetRow>(`SELECT ${PRESET} FROM presets WHERE project IS NULL OR project = ? ORDER BY project IS NOT NULL, lower(name), id`, project ?? null)).map(presetOf)
    }

    async preset(id: number): Promise<Preset> {
        const row = Number.isInteger(id) ? await this.get<PresetRow>(`SELECT ${PRESET} FROM presets WHERE id = ?`, id) : undefined
        if (!row) throw notFound(`No preset ${id}`)
        return presetOf(row)
    }

    /** Adds the presets orrery ships that this orrery hasn't had yet, as it starts: all of them in a new one, a new
     * one after an upgrade. One the owner removed isn't added again. A saved one whose text is still one orrery
     * shipped before (`was`) takes today's; one the owner changed keeps theirs. Says how many it added. */
    async seedPresets(): Promise<number> {
        return await this.db.transaction(async () => {
            const seeded = new Set((await this.all<{key: string}>('SELECT key FROM preset_defaults')).map(r => r.key))
            const due = DEFAULT_PRESETS.filter(d => !seeded.has(d.key))
            for (const d of due) {
                await this.addDefault(d)
                await this.run('INSERT INTO preset_defaults (key, seeded_at) VALUES (?, ?)', d.key, stamp())
            }
            for (const d of DEFAULT_PRESETS) {
                for (const old of d.was ?? []) await this.run('UPDATE presets SET text = ?, updated_at = ? WHERE default_key = ? AND text = ?', d.text, stamp(), d.key, old)
            }
            return due.length
        })
    }

    /** Puts a default preset back as orrery ships it: its name, text and badge. The owner's only. */
    async resetPreset(id: number, actor = AGENT): Promise<Preset> {
        ownerOnly(actor, 'presets.write')
        const preset = await this.preset(id)
        const shipped = DEFAULT_PRESETS.find(d => d.key === preset.default?.key)
        if (!shipped) throw conflict(`Resetting preset ${id}: ${preset.name} isn't one orrery ships, so it has no default`)
        await this.update('presets', 'id = ?', [id], {name: shipped.name, text: shipped.text, icon: shipped.icon, color: shipped.color})
        return await this.preset(id)
    }

    /** Adds back the presets orrery ships that were removed, as it ships them; says which. The owner's only. */
    async restorePresets(actor = AGENT): Promise<Preset[]> {
        ownerOnly(actor, 'presets.write')
        const kept = new Set((await this.all<{default_key: string}>('SELECT default_key FROM presets WHERE default_key IS NOT NULL')).map(r => r.default_key))
        const restored: Preset[] = []
        for (const d of DEFAULT_PRESETS.filter(d => !kept.has(d.key))) restored.push(await this.preset(await this.addDefault(d)))
        return restored
    }

    private async addDefault(d: (typeof DEFAULT_PRESETS)[number]): Promise<number> {
        const now = stamp()
        const row = await this.one<{id: number}>(`INSERT INTO presets (project, name, text, icon, color, default_key, created_by, owned, created_at, updated_at)
            VALUES (NULL, ?, ?, ?, ?, ?, 'orrery', 1, ?, ?) RETURNING id`, d.name, d.text, d.icon, d.color, d.key, now, now)
        return Number(row.id)
    }

    /** A new preset, the owner's to make: `{name, text, icon?, color?}`, the orrery's, or with `project` that project's own. */
    async createPreset(project: string | null, body: unknown, actor = AGENT): Promise<Preset> {
        ownerOnly(actor, 'presets.write')
        if (project) await this.projectRow(project)
        const input = checkInput(body, PRESET_FIELDS)
        const {name, text} = presetInput(input)
        const now = stamp()
        const row = await this.one<{id: number}>('INSERT INTO presets (project, name, text, icon, color, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
            project, known(name, 'a name'), known(text, 'a text'), nullable(input.icon), nullable(input.color), actor.name, Number(actor.owner), now, now)
        return await this.preset(Number(row.id))
    }

    /** Renames a preset, or changes its text or badge (null takes the icon or colour off); whose it is stays. */
    async updatePreset(id: number, body: unknown, actor = AGENT): Promise<Preset> {
        ownerOnly(actor, 'presets.write')
        await this.preset(id)
        const input = checkInput(body, PRESET_FIELDS, true)
        const {name, text} = presetInput(input)
        await this.update('presets', 'id = ?', [id], {name, text, icon: input.icon, color: input.color})
        return await this.preset(id)
    }

    async deletePreset(id: number, actor = AGENT) {
        ownerOnly(actor, 'presets.write')
        await this.preset(id)
        await this.run('DELETE FROM presets WHERE id = ?', id)
    }

    /** The presets picked for a session on the project, in the order picked: each the orrery's or the project's own. */
    async presetsFor(project: string, ids: number[]): Promise<Preset[]> {
        const usable = await this.presets(project)
        const unknown = ids.filter(id => !usable.some(p => p.id === id))
        if (unknown.length) throw badRequest(`No preset ${unknown.join(', ')} for ${project}; its sessions can have ${usable.map(p => `${p.id} (${p.name})`).join(', ') || 'none yet'}`)
        return [...new Set(ids)].map(id => known(usable.find(p => p.id === id), `preset ${id}`))
    }
}

const PRESET = 'id, project, name, text, icon, color, default_key, created_at, updated_at'

/** A preset as the API gives it: a default says which, and whether it's been changed since. */
function presetOf({default_key, ...row}: PresetRow): Preset {
    const shipped = default_key ? DEFAULT_PRESETS.find(d => d.key === default_key) : undefined
    return {...row, ...shipped ? {default: {key: shipped.key, changed: !asShipped(row, shipped)}} : {}}
}
