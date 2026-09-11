export const DEAD_LETTER_REASONS = {
  INVALID_UTF8: 'INVALID_UTF8',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  EVENT_TYPE_MISMATCH: 'EVENT_TYPE_MISMATCH',
} as const;

export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[keyof typeof DEAD_LETTER_REASONS];

export interface DeadLetterRecord {
  reason: DeadLetterReason | string;
  routingKey: string;
  timestamp: string;
  messageId?: string;
  payload: unknown;
}

export type DecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: typeof DEAD_LETTER_REASONS.INVALID_UTF8 | typeof DEAD_LETTER_REASONS.INVALID_JSON; payload: unknown };

export function decodeAmqpContent(buffer: Buffer): DecodeResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {
      ok: false,
      reason: DEAD_LETTER_REASONS.INVALID_UTF8,
      payload: { encoding: 'base64', data: buffer.toString('base64') },
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      reason: DEAD_LETTER_REASONS.INVALID_JSON,
      payload: text,
    };
  }
}

export function createDeadLetterRecord(
  payload: unknown,
  meta: { reason: string; routingKey: string; messageId?: string },
): DeadLetterRecord {
  return {
    reason: meta.reason,
    routingKey: meta.routingKey,
    timestamp: new Date().toISOString(),
    messageId: meta.messageId,
    payload,
  };
}
