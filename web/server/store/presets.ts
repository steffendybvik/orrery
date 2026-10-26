// Presets: the context a session can be started with, the Orrery's or a project's.
import type {Preset} from '#shared/roadmap'
import {badRequest, checkInput, notFound} from '../utils/input'
import type {PresetRow} from './schema'
import {AGENT, PRESET_FIELDS, presetInput, stamp} from './schema'
import {ProjectStore} from './projects'

export abstract class PresetStore extends ProjectStore {
    /** The Orrery's presets, by name; with a project, those a session on it can have: the Orrery's, then its own. */
    async presets(project?: string): Promise<Preset[]> {
        if (project) await this.projectRow(project)
        return await this.all<PresetRow>('SELECT id, project, name, text, created_at, updated_at FROM presets WHERE project IS NULL OR project = ? ORDER BY project IS NOT NULL, lower(name), id', project ?? null)
    }

    async preset(id: number): Promise<Preset> {
        const row = Number.isInteger(id) ? await this.get<PresetRow>('SELECT id, project, name, text, created_at, updated_at FROM presets WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No preset ${id}`)
        return row
    }

    /** A new preset, the owner's to make: `{name, text}`, the Orrery's, or with `project` that project's own. */
    async createPreset(project: string | null, body: unknown, actor = AGENT): Promise<Preset> {
        this.ownerOnly(actor, 'presets')
        if (project) await this.projectRow(project)
        const {name, text} = presetInput(checkInput(body, PRESET_FIELDS))
        const now = stamp()
        const row = await this.get<{id: number}>('INSERT INTO presets (project, name, text, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
            project, name!, text!, actor.name, Number(actor.owner), now, now)
        return await this.preset(Number(row!.id))
    }

    /** Renames a preset or changes its text; whose it is stays. */
    async updatePreset(id: number, body: unknown, actor = AGENT): Promise<Preset> {
        this.ownerOnly(actor, 'presets')
        await this.preset(id)
        const {name, text} = presetInput(checkInput(body, PRESET_FIELDS, true))
        await this.run('UPDATE presets SET name = coalesce(?, name), text = coalesce(?, text), updated_at = ? WHERE id = ?', name ?? null, text ?? null, stamp(), id)
        return await this.preset(id)
    }

    async deletePreset(id: number, actor = AGENT) {
        this.ownerOnly(actor, 'presets')
        await this.preset(id)
        await this.run('DELETE FROM presets WHERE id = ?', id)
    }

    /** The presets picked for a session on the project, in the order picked: each the Orrery's or the project's own. */
    async presetsFor(project: string, ids: number[]): Promise<Preset[]> {
        const usable = await this.presets(project)
        const unknown = ids.filter(id => !usable.some(p => p.id === id))
        if (unknown.length) throw badRequest(`No preset ${unknown.join(', ')} for ${project}; its sessions can have ${usable.map(p => `${p.id} (${p.name})`).join(', ') || 'none yet'}`)
        return [...new Set(ids)].map(id => usable.find(p => p.id === id)!)
    }
}
