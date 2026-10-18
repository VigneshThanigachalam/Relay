import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/relay?replicaSet=rs0' };

describe('configuration', () => {
  it('defaults to the assignment two-hour threshold', () => {
    expect(parseEnv(base)).toMatchObject({
      PORT: 4000,
      ASSIGNMENT_RESPONSE_THRESHOLD_MS: 2 * 60 * 60 * 1000,
      TIMEOUT_SCAN_INTERVAL_MS: 5000,
    });
  });

  it('allows a reviewer to configure a short timeout without code edits', () => {
    expect(
      parseEnv({
        ...base,
        ASSIGNMENT_RESPONSE_THRESHOLD_MS: '5000',
        TIMEOUT_SCAN_INTERVAL_MS: '1000',
      }),
    ).toMatchObject({ ASSIGNMENT_RESPONSE_THRESHOLD_MS: 5000, TIMEOUT_SCAN_INTERVAL_MS: 1000 });
  });

  it.each(['0', '-1', 'abc', '1.5', '604800001'])('rejects invalid threshold %s', (value) => {
    expect(() => parseEnv({ ...base, ASSIGNMENT_RESPONSE_THRESHOLD_MS: value })).toThrow(
      'ASSIGNMENT_RESPONSE_THRESHOLD_MS',
    );
  });

  it.each(['0', '65536', 'NaN'])('rejects invalid port %s', (PORT) => {
    expect(() => parseEnv({ ...base, PORT })).toThrow('PORT');
  });

  it('requires a database URI instead of silently substituting another database', () => {
    expect(() => parseEnv({})).toThrow('MONGODB_URI');
  });

  it('does not expose connection credentials in configuration errors', () => {
    expect(() => parseEnv({ MONGODB_URI: 'https://alice:private-secret@example.com' })).toThrow(
      /^Invalid configuration fields: MONGODB_URI$/,
    );
  });
});
