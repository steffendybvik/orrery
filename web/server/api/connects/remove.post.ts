// `POST /api/connects/remove {dir, projects}` → {projects}: Remove on Connected repos (ORR-1260). The owner's launchers
// serving `projects` from the folder `dir` take them off their list, as `--uninstall` there would, and keep it off for
// pick-up; Connect a repo or `--install` puts it back. The projects, their issues and the sessions running there are left
// alone. `dir` is only ever one a launcher said it serves, sent back to those launchers; 404 when none serves it now.
export default defineEventHandler(async event => {
    await authorize(event, 'connects.remove')
    const {dir, projects} = checkInput(await readBody(event), {dir: {type: 'string', required: true}, projects: {type: 'strings', required: true}})
    return {projects: removeRepo(String(dir), [...new Set((projects as unknown[]).map(String))])}
})
