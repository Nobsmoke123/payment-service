import { decodeAmqpContent, DEAD_LETTER_REASONS } from '../../src/messaging/message.validation';

describe('decodeAmqpContent', () => {
  it('parses valid JSON', () => {
    expect(decodeAmqpContent(Buffer.from('{"ok":true}'))).toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it('returns INVALID_JSON for malformed JSON', () => {
    expect(decodeAmqpContent(Buffer.from('{nope'))).toEqual({
      ok: false,
      reason: DEAD_LETTER_REASONS.INVALID_JSON,
      payload: '{nope',
    });
  });

  it('returns INVALID_UTF8 for an illegal byte sequence', () => {
    const result = decodeAmqpContent(Buffer.from([0xc3, 0x28]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(DEAD_LETTER_REASONS.INVALID_UTF8);
      expect(result.payload).toEqual({
        encoding: 'base64',
        data: Buffer.from([0xc3, 0x28]).toString('base64'),
      });
    }
  });
});
