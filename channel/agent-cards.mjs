// How each agent's sessions are shown on their cards (ORR-1074): the adapters' part the web draws, so it has no
// imports that need node. Claude Code's is the only one so far (claude-card.mjs); which agent a session runs is ORR-1075's.
import {claudeCard} from './claude-card.mjs'

/**
 * @typedef {object} AgentCard
 * @property {string} name
 * @property {(id: string) => string} modelLabel a model's id as people say it
 * @property {(session: {model?: string, effort?: string, started?: {model?: string, effort?: string}}, size?: 'normal' | 'condensed') => {label: string | undefined, title: string}} chip
 *   what the card's chip says of what it runs on, and its title
 */

const CARDS = {claude: claudeCard}

/** How an agent's sessions are shown, by name; Claude Code's when none is named, or for an agent with no card. */
export function cardFor(name = 'claude') {
    return CARDS[name] ?? claudeCard
}
