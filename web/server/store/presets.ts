// Presets: the context a session can be started with, the Orrery's or a project's.
import type {Preset} from '#shared/roadmap'
import {badRequest, checkInput, notFound} from '../utils/input'
import type {PresetRow} from './schema'
import {AGENT, PRESET_FIELDS, nullable, presetInput, stamp} from './schema'
import {ProjectStore} from './projects'
import {known} from '#shared/known'

export abstract class PresetStore extends ProjectStore {
    /** The Orrery's presets, by name; with a project, those a session on it can have: the Orrery's, then its own. */
    async presets(project?: string): Promise<Preset[]> {
        if (project) await this.projectRow(project)
        return await this.all<PresetRow>('SELECT id, project, name, text, icon, color, created_at, updated_at FROM presets WHERE project IS NULL OR project = ? ORDER BY project IS NOT NULL, lower(name), id', project ?? null)
    }

    async preset(id: number): Promise<Preset> {
        const row = Number.isInteger(id) ? await this.get<PresetRow>('SELECT id, project, name, text, icon, color, created_at, updated_at FROM presets WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No preset ${id}`)
        return row
    }

    /** A new preset: `{name, text, icon?, color?}`, the Orrery's, or with `project` that project's own. A session
     * makes one when the owner asks; it only reaches a session the owner starts with it ticked. */
    async createPreset(project: string | null, body: unknown, actor = AGENT): Promise<Preset> {
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
        await this.preset(id)
        const input = checkInput(body, PRESET_FIELDS, true)
        const {name, text} = presetInput(input)
        await this.update('presets', 'id = ?', [id], {name, text, icon: input.icon, color: input.color})
        return await this.preset(id)
    }

    /** Removes a preset; one the owner made is theirs to remove. */
    async deletePreset(id: number, actor = AGENT) {
        const {name} = await this.preset(id)
        const {owned} = await this.one<{owned: number}>('SELECT owned FROM presets WHERE id = ?', id)
        this.refuse(actor, `Deleting preset "${name}"`, owned ? [`preset "${name}"`] : [])
        await this.run('DELETE FROM presets WHERE id = ?', id)
    }

    /** The presets picked for a session on the project, in the order picked: each the Orrery's or the project's own. */
    async presetsFor(project: string, ids: number[]): Promise<Preset[]> {
        const usable = await this.presets(project)
        const unknown = ids.filter(id => !usable.some(p => p.id === id))
        if (unknown.length) throw badRequest(`No preset ${unknown.join(', ')} for ${project}; its sessions can have ${usable.map(p => `${p.id} (${p.name})`).join(', ') || 'none yet'}`)
        return [...new Set(ids)].map(id => known(usable.find(p => p.id === id), `preset ${id}`))
    }
}
