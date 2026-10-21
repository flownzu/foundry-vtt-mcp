import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface SceneBuilderToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const DOCUMENT_TYPES = [
  'Wall',
  'AmbientLight',
  'AmbientSound',
  'Region',
  'Tile',
  'Token',
  'Note',
  'Drawing',
] as const;

const manageSceneSchema = z
  .object({
    action: z.enum([
      'create-scene',
      'update-scene',
      'create-documents',
      'update-documents',
      'delete-documents',
      'list-documents',
    ]),
    sceneIdentifier: z.string().min(1).optional(),
    sceneData: z.record(z.unknown()).optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    documents: z.array(z.record(z.unknown())).min(1).optional(),
    ids: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const need = (field: keyof typeof data, message: string) => {
      if (data[field] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (data.action === 'create-scene') need('sceneData', 'sceneData is required for create-scene');
    if (data.action !== 'create-scene') need('sceneIdentifier', 'sceneIdentifier is required');
    if (data.action === 'update-scene') need('sceneData', 'sceneData is required for update-scene');
    if (data.action.endsWith('-documents')) need('documentType', 'documentType is required');
    if (data.action === 'create-documents' || data.action === 'update-documents') {
      need('documents', 'documents is required');
    }
    if (data.action === 'delete-documents') need('ids', 'ids is required for delete-documents');
  });

export class SceneBuilderTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SceneBuilderToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SceneBuilderTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-scene',
        description:
          'Create or update a Scene and manage its embedded documents (Wall, AmbientLight, AmbientSound, Region, Tile, Token, Note, Drawing). ' +
          'Payloads are generic Foundry document data (v13). ' +
          '"create-scene": sceneData with name, background.src, width, height, grid {size, type}, etc. ' +
          '"update-scene": sceneIdentifier + sceneData. ' +
          '"create-documents" / "update-documents": sceneIdentifier + documentType + documents (update entries need _id). ' +
          '"delete-documents": sceneIdentifier + documentType + ids. ' +
          '"list-documents": sceneIdentifier + documentType, returns compact document data.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'create-scene',
                'update-scene',
                'create-documents',
                'update-documents',
                'delete-documents',
                'list-documents',
              ],
            },
            sceneIdentifier: { type: 'string', description: 'Scene ID or exact case-insensitive name.' },
            sceneData: { type: 'object', additionalProperties: true, description: 'Scene document fields.' },
            documentType: { type: 'string', enum: [...DOCUMENT_TYPES] },
            documents: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'Embedded document data. For update-documents each entry must include _id.',
            },
            ids: { type: 'array', items: { type: 'string' }, description: 'Embedded document IDs to delete.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleManageScene(args: unknown): Promise<any> {
    const parsed = manageSceneSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    this.logger.info('Managing scene', {
      action: parsed.data.action,
      sceneIdentifier: parsed.data.sceneIdentifier,
      documentType: parsed.data.documentType,
    });

    try {
      return await this.foundryClient.query('foundry-mcp-bridge.manageScene', parsed.data);
    } catch (error) {
      this.logger.error('Failed to manage scene', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
