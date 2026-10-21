import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface CalendarClockToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const calendarClockSchema = z.object({ action: z.enum(['start', 'pause', 'stop', 'status']) }).strict();

/** Uhr von Simple Calendar Reborn im Browser des Haupt-GM starten, anhalten, abfragen. */
export class CalendarClockTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: CalendarClockToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CalendarClockTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'calendar-clock',
        description:
          'Start, stop or read the real-time clock of Simple Calendar Reborn (the play/pause button of the calendar). ' +
          'Runs in the primary GM browser. Returns the clock status (started, paused, stopped); ' +
          '"paused" after start means the game is paused or a combat is running.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['start', 'pause', 'stop', 'status'] } },
          required: ['action'],
        },
      },
    ];
  }

  async handleCalendarClock(args: unknown): Promise<any> {
    const parsed = calendarClockSchema.safeParse(args);
    if (!parsed.success) return { success: false, error: 'Invalid arguments: action must be start, pause, stop or status' };
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.calendarClock', parsed.data);
    } catch (error) {
      this.logger.error('Failed to control calendar clock', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
