import { requireEnv } from '../../../src/lib/env';

describe('requireEnv', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('returns the value when the env var is set', () => {
    process.env.TEST_VAR = 'hello';
    expect(requireEnv('TEST_VAR')).toBe('hello');
  });

  it('returns the exact value without trimming or modification', () => {
    process.env.TEST_VAR = '  spaces preserved  ';
    expect(requireEnv('TEST_VAR')).toBe('  spaces preserved  ');
  });

  it('returns the value for a different variable name', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    expect(requireEnv('DATABASE_URL')).toBe('postgresql://localhost/test');
  });

  // ---------------------------------------------------------------------------
  // Edge cases — missing or empty
  // ---------------------------------------------------------------------------

  it('throws when the env var is undefined', () => {
    delete process.env.MISSING_VAR;
    expect(() => requireEnv('MISSING_VAR')).toThrow(
      'Missing required environment variable: MISSING_VAR',
    );
  });

  it('throws when the env var is an empty string', () => {
    process.env.EMPTY_VAR = '';
    expect(() => requireEnv('EMPTY_VAR')).toThrow(
      'Missing required environment variable: EMPTY_VAR',
    );
  });

  it('includes the variable name in the error message', () => {
    delete process.env.ALCHEMY_API_KEY;
    expect(() => requireEnv('ALCHEMY_API_KEY')).toThrow('ALCHEMY_API_KEY');
  });

  it('error message mentions .env.local to guide the developer', () => {
    delete process.env.REDIS_URL;
    expect(() => requireEnv('REDIS_URL')).toThrow('.env.local');
  });

  it('throws an Error (not a plain string)', () => {
    delete process.env.MISSING_VAR;
    expect(() => requireEnv('MISSING_VAR')).toThrow(Error);
  });
});
