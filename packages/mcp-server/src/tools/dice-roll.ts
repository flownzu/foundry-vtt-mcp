import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

interface DiceRollToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class DiceRollTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor(options: DiceRollToolsOptions) {
    this.foundryClient = options.foundryClient;
    this.logger = options.logger;
  }

  getToolDefinitions() {
    return [
      {
        name: 'request-player-rolls',
        description:
          'Request dice rolls from players with interactive buttons. Creates roll buttons in Foundry chat that players can click. VISIBILITY WORKFLOW: Before calling this function, ensure the user has specified whether they want a public or private roll. If they have already specified "public" or "private" in their request (e.g., "public performance check", "private stealth roll"), you can proceed directly. If the visibility is ambiguous or unspecified, ask: "Do you want this to be a PUBLIC roll (visible to all players) or PRIVATE roll (visible to player and GM only)?" and wait for their answer. Supports character-to-player resolution and GM fallback.',
        inputSchema: {
          type: 'object',
          properties: {
            rollType: {
              type: 'string',
              description:
                'Type of roll to request (ability, skill, save, attack, initiative, custom)',
              enum: ['ability', 'skill', 'save', 'attack', 'initiative', 'custom'],
            },
            rollTarget: {
              type: 'string',
              description:
                'Target for the roll - can be ability name (str, dex, con, int, wis, cha), skill name (perception, insight, stealth, etc.), or custom roll formula',
            },
            targetPlayer: {
              type: 'string',
              description: 'Player name or character name to request the roll from',
            },
            isPublic: {
              type: 'boolean',
              description:
                'Whether the roll should be public (true = visible to all players) or private (false = visible only to target player and GM).',
            },
            userConfirmedVisibility: {
              type: 'boolean',
              const: true,
              description:
                'REQUIRED: Must be set to true to confirm the roll visibility has been determined. This can happen in two ways: 1) User explicitly specified "public" or "private" in their original request (e.g., "public stealth check"), or 2) You asked the clarifying question and received their answer. Only set this to true when you are confident about the visibility preference, either from their original request or from a direct answer to your question.',
            },
            rollModifier: {
              type: 'string',
              description: 'Optional modifier to add to the roll (e.g., "+2", "-1", "+1d4")',
              default: '',
            },
            flavor: {
              type: 'string',
              description: 'Optional flavor text to describe the roll context',
              default: '',
            },
            // Local patch: preselect advantage/disadvantage in the player's dnd5e roll dialog
            advantageMode: {
              type: 'string',
              enum: ['normal', 'advantage', 'disadvantage'],
              description:
                'Advantage mode for skill, save and ability rolls: preselected in the dnd5e roll dialog the player gets (the player can still change it). Default normal.',
              default: 'normal',
            },
          },
          required: [
            'rollType',
            'rollTarget',
            'targetPlayer',
            'isPublic',
            'userConfirmedVisibility',
          ],
        },
      },
      // Local patch: read recent chat messages / roll results
      {
        name: 'get-chat-messages',
        description:
          'Read the most recent Foundry chat messages (GM view, includes whispers), oldest first. Each message has author, speaker/actor, flavor, plain-text content, visibility and roll results (formula, total, individual dice). Use rollsOnly to get only roll messages, e.g. to see the result of a roll requested with request-player-rolls.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of most recent messages to return (1-50, default 10)',
              minimum: 1,
              maximum: 50,
              default: 10,
            },
            rollsOnly: {
              type: 'boolean',
              description: 'Only return messages that contain dice rolls',
              default: false,
            },
          },
        },
      },
    ];
  }

  async handleRequestPlayerRolls(args: any) {
    const schema = z.object({
      rollType: z.enum(['ability', 'skill', 'save', 'attack', 'initiative', 'custom']),
      rollTarget: z.string(),
      targetPlayer: z.string(),
      isPublic: z.boolean(),
      userConfirmedVisibility: z.literal(true),
      rollModifier: z.string().default(''),
      flavor: z.string().default(''),
      advantageMode: z.enum(['normal', 'advantage', 'disadvantage']).default('normal'),
    });

    try {
      const params = schema.parse(args);

      // Validation should be handled by schema, but add extra safety checks
      if (typeof params.isPublic !== 'boolean') {
        return 'Please specify whether you want this to be a PUBLIC roll (visible to all players) or PRIVATE roll (visible only to the target player and GM). You must provide either "true" for public or "false" for private.';
      }

      if (params.userConfirmedVisibility !== true) {
        return 'You must determine the roll visibility before calling this function. Either: 1) The user already specified "public" or "private" in their request, or 2) You need to ask: "Do you want this to be a PUBLIC roll or PRIVATE roll?" Set userConfirmedVisibility to true only when you are confident about the visibility preference.';
      }

      const response = await this.foundryClient.query(
        'foundry-mcp-bridge.request-player-rolls',
        params
      );

      if (response.success) {
        return `Roll request sent successfully! ${response.message}`;
      } else {
        throw new Error(response.error || 'Failed to request player rolls');
      }
    } catch (error) {
      this.logger.error('Error requesting player rolls', error);
      if (error instanceof z.ZodError) {
        const messages = error.errors.map(e => {
          if (e.path.includes('isPublic')) {
            return 'You must specify whether the roll should be PUBLIC (visible to all players) or PRIVATE (visible only to target player and GM). Check if the user already specified this in their request, or ask them to clarify.';
          }
          return e.message;
        });
        return `Parameter error: ${messages.join(', ')}`;
      }
      throw error;
    }
  }

  // Local patch: read recent chat messages / roll results
  async handleGetChatMessages(args: any) {
    const schema = z.object({
      limit: z.number().min(1).max(50).default(10),
      rollsOnly: z.boolean().default(false),
    });
    const params = schema.parse(args ?? {});
    const response = await this.foundryClient.query('foundry-mcp-bridge.getChatMessages', params);
    if (response?.success === false) {
      throw new Error(response.error || 'Failed to get chat messages');
    }
    return response;
  }
}
