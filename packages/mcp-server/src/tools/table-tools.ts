import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface TableToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const targets = z.array(z.string().min(1)).min(1);
const scene = z.string().optional();

const schemas = {
  combat: z
    .object({
      action: z.enum([
        'status',
        'add',
        'remove',
        'roll-initiative',
        'set-initiative',
        'begin',
        'next-turn',
        'previous-turn',
        'next-round',
        'previous-round',
        'defeated',
        'end',
      ]),
      sceneIdentifier: scene,
      targets: z.array(z.string().min(1)).optional(),
      include: z.enum(['hostile', 'pcs', 'all']).optional(),
      who: z.enum(['npcs', 'all', 'targets']).optional(),
      initiative: z.number().optional(),
      defeated: z.boolean().optional(),
    })
    .strict(),
  'apply-damage': z
    .object({
      sceneIdentifier: scene,
      targets,
      amount: z.number().int().min(0),
      type: z.string().optional(),
      multiplier: z.number().min(0).max(4).optional(),
      allMatches: z.boolean().optional(),
    })
    .strict(),
  'party-status': z.object({ includeFeatures: z.boolean().optional() }).strict(),
  'gm-roll': z
    .object({
      formula: z.string().optional(),
      sceneIdentifier: scene,
      targets: z.array(z.string().min(1)).optional(),
      rollType: z.enum(['skill', 'save', 'ability', 'passive']).optional(),
      key: z.string().optional(),
      advantageMode: z.enum(['normal', 'advantage', 'disadvantage']).optional(),
      visibility: z.enum(['blind', 'gm', 'none']).optional(),
      flavor: z.string().optional(),
    })
    .strict(),
  'roll-table': z
    .object({
      action: z.enum(['list', 'roll']),
      table: z.string().optional(),
      search: z.string().optional(),
      visibility: z.enum(['public', 'gm', 'blind', 'none']).optional(),
    })
    .strict(),
  'post-chat': z
    .object({
      content: z.string().min(1),
      speaker: z.string().optional(),
      whisperTo: z.array(z.string().min(1)).optional(),
      style: z.enum(['ic', 'ooc', 'emote']).optional(),
    })
    .strict(),
  'run-macro': z
    .object({
      action: z.enum(['list', 'run']),
      macro: z.string().optional(),
      search: z.string().optional(),
    })
    .strict(),
  'scene-view': z
    .object({
      action: z.enum(['ping', 'pull-players', 'reset-fog', 'weather', 'list-weather']),
      sceneIdentifier: scene,
      target: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      weather: z.string().optional(),
    })
    .strict(),
  'creature-card': z
    .object({ target: z.string().optional(), actor: z.string().optional(), sceneIdentifier: scene })
    .strict(),
} as const;

type ToolName = keyof typeof schemas;

const queryNames: Record<ToolName, string> = {
  combat: 'combatControl',
  'apply-damage': 'applyDamage',
  'party-status': 'partyStatus',
  'gm-roll': 'gmRoll',
  'roll-table': 'rollTable',
  'post-chat': 'postChat',
  'run-macro': 'runMacro',
  'scene-view': 'sceneView',
  'creature-card': 'creatureCard',
};

const sceneProp = {
  type: 'string',
  description: 'Scene id or name. Default: the active scene (where the players are).',
};
const targetsProp = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Token ids or token names on the scene (case-insensitive); player characters also by actor name.',
};

/** Werkzeuge für den Spieltisch: Kampf, Schaden, Gruppenstatus, verdeckte Würfe, Tabellen, Chat, Makros, Ansicht. */
export class TableTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: TableToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'TableTools' });
  }

  static readonly toolNames = Object.keys(schemas) as ToolName[];

  getToolDefinitions() {
    return [
      {
        name: 'combat',
        description:
          'Read and control the combat tracker of a scene. status: round, turn and combatants (initiative, HP, AC, defeated, hidden). ' +
          'add: put tokens into the combat (targets, or include=hostile|pcs|all); creates the combat if none exists. remove: take targets out. ' +
          'roll-initiative: who=npcs (default, only those without initiative), all (everyone without initiative) or targets; rolled as GM roll. ' +
          'set-initiative: targets + initiative. begin: start round 1. next-turn, previous-turn, next-round, previous-round. ' +
          'defeated: mark targets defeated (defeated=false to undo). end: delete the combat. Every action returns the status.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'status',
                'add',
                'remove',
                'roll-initiative',
                'set-initiative',
                'begin',
                'next-turn',
                'previous-turn',
                'next-round',
                'previous-round',
                'defeated',
                'end',
              ],
            },
            sceneIdentifier: sceneProp,
            targets: targetsProp,
            include: { type: 'string', enum: ['hostile', 'pcs', 'all'] },
            who: { type: 'string', enum: ['npcs', 'all', 'targets'] },
            initiative: { type: 'number' },
            defeated: { type: 'boolean' },
          },
          required: ['action'],
        },
      },
      {
        name: 'apply-damage',
        description:
          'Apply damage or healing to tokens through dnd5e (resistances, immunities, vulnerabilities, temp HP and concentration checks apply). ' +
          'type: a damage type (bludgeoning, fire, ...), "healing" or "temphp"; without type the damage is untyped and ignores resistances. ' +
          'multiplier 0.5 for half damage on a save. Names that match several tokens fail unless allMatches=true. Returns HP before and after.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneIdentifier: sceneProp,
            targets: targetsProp,
            amount: { type: 'integer', minimum: 0 },
            type: { type: 'string' },
            multiplier: { type: 'number' },
            allMatches: { type: 'boolean' },
          },
          required: ['targets', 'amount'],
        },
      },
      {
        name: 'party-status',
        description:
          'Compact live status of all player characters in one call: HP, temp HP, AC, spell slots, concentration, conditions, exhaustion, ' +
          'hit dice, inspiration, death saves, passive perception/insight/investigation. includeFeatures adds features and items with limited uses.',
        inputSchema: { type: 'object', properties: { includeFeatures: { type: 'boolean' } } },
      },
      {
        name: 'gm-roll',
        description:
          'Roll hidden from the players. Either a formula ("1d20+5", "2d6") or a dnd5e roll for tokens: rollType skill|save|ability with key ' +
          '(skill: ste, prc, ins, ...; save/ability: str, dex, con, int, wis, cha), or rollType passive (no roll, reads the passive skill value). ' +
          'visibility: blind (default, only GM sees it in chat), gm (GM roll, roller and GM), none (no chat message). Returns totals and natural d20.',
        inputSchema: {
          type: 'object',
          properties: {
            formula: { type: 'string' },
            sceneIdentifier: sceneProp,
            targets: targetsProp,
            rollType: { type: 'string', enum: ['skill', 'save', 'ability', 'passive'] },
            key: { type: 'string' },
            advantageMode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'] },
            visibility: { type: 'string', enum: ['blind', 'gm', 'none'] },
            flavor: { type: 'string' },
          },
        },
      },
      {
        name: 'roll-table',
        description:
          'Roll tables of the world and of compendiums. list: tables with name, id/uuid and formula (search filters by name). ' +
          'roll: draw from a table by name, id or uuid; visibility public|gm (default)|blind|none decides the chat message. Returns the drawn results as text.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'roll'] },
            table: { type: 'string' },
            search: { type: 'string' },
            visibility: { type: 'string', enum: ['public', 'gm', 'blind', 'none'] },
          },
          required: ['action'],
        },
      },
      {
        name: 'post-chat',
        description:
          'Post a chat message as the GM. speaker: a token or actor name to speak in character (style ic) or emote. ' +
          'whisperTo: user names or character names; the GM always receives whispers too. Content may contain simple HTML.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            speaker: { type: 'string' },
            whisperTo: { type: 'array', items: { type: 'string' } },
            style: { type: 'string', enum: ['ic', 'ooc', 'emote'] },
          },
          required: ['content'],
        },
      },
      {
        name: 'run-macro',
        description:
          'List or run an existing macro of the world by name or id. Runs in the GM browser. Only existing macros, no free code.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'run'] },
            macro: { type: 'string' },
            search: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'scene-view',
        description:
          'View controls for the scene the GM browser is showing. ping: ping a token (target) or point (x, y). ' +
          'pull-players: ping and pull every player view there. reset-fog: reset the fog of war of the scene. ' +
          'weather: set the weather effect of a scene ("" clears it); list-weather: the available effects.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['ping', 'pull-players', 'reset-fog', 'weather', 'list-weather'],
            },
            sceneIdentifier: sceneProp,
            target: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            weather: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'creature-card',
        description:
          'Compact stat block with derived values for a token on the scene (target) or a world actor (actor: name, id or uuid): ' +
          'CR, HP, AC, initiative, speed, abilities, proficient saves and skills, senses, resistances/immunities, legendary actions, ' +
          'and actions with activation, to-hit, save DC, damage, uses or recharge. For quick reference at the table.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Token id or name on the scene' },
            actor: {
              type: 'string',
              description: 'World actor name, id or uuid (also compendium uuid)',
            },
            sceneIdentifier: sceneProp,
          },
        },
      },
    ];
  }

  async handle(name: ToolName, args: unknown): Promise<any> {
    const parsed = schemas[name].safeParse(args ?? {});
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid arguments: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      };
    }
    try {
      return await this.foundryClient.query(`foundry-mcp-bridge.${queryNames[name]}`, parsed.data);
    } catch (error) {
      this.logger.error(`Failed: ${name}`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
