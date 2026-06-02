import { describe, expect, it } from 'vitest';
import { clampVolume, generateRoomCode, parseYouTubeId, validateReason } from './index.js';

describe('parseYouTubeId', () => {
  const ID = 'dQw4w9WgXcQ';

  it('parses youtu.be/<id>', () => {
    expect(parseYouTubeId(`https://youtu.be/${ID}`)).toBe(ID);
  });

  it('parses youtu.be/<id> with query params', () => {
    expect(parseYouTubeId(`https://youtu.be/${ID}?t=42`)).toBe(ID);
  });

  it('parses youtube.com/watch?v=<id>', () => {
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('parses youtube.com/watch?v=<id> with extra params', () => {
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}&list=abc&t=10`)).toBe(ID);
  });

  it('parses youtube.com/embed/<id>', () => {
    expect(parseYouTubeId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
  });

  it('parses youtube.com/shorts/<id>', () => {
    expect(parseYouTubeId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
  });

  it('parses music.youtube.com/watch?v=<id>', () => {
    expect(parseYouTubeId(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('returns null for a non-YouTube URL', () => {
    expect(parseYouTubeId('https://vimeo.com/123456789')).toBeNull();
  });

  it('returns null for malformed/empty input', () => {
    expect(parseYouTubeId('not a url')).toBeNull();
    expect(parseYouTubeId('')).toBeNull();
  });

  it('returns ids that match the 11-char [A-Za-z0-9_-] shape', () => {
    const id = parseYouTubeId(`https://youtu.be/${ID}`);
    expect(id).not.toBeNull();
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('returns null when id is not 11 chars', () => {
    expect(parseYouTubeId('https://youtu.be/short')).toBeNull();
  });
});

describe('validateReason', () => {
  it('is false for empty string', () => {
    expect(validateReason('')).toBe(false);
  });

  it('is false for whitespace only', () => {
    expect(validateReason('  ')).toBe(false);
  });

  it('is true for non-empty content', () => {
    expect(validateReason('x')).toBe(true);
  });
});

describe('clampVolume', () => {
  it('clamps below 0 to 0', () => {
    expect(clampVolume(-5)).toBe(0);
  });

  it('clamps above 100 to 100', () => {
    expect(clampVolume(105)).toBe(100);
  });

  it('rounds 33.4 down to 33', () => {
    expect(clampVolume(33.4)).toBe(33);
  });

  it('rounds 33.6 up to 34', () => {
    expect(clampVolume(33.6)).toBe(34);
  });
});

describe('generateRoomCode', () => {
  const CHARSET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

  it('produces a 6-char code', () => {
    expect(generateRoomCode()).toHaveLength(6);
  });

  it('only uses allowed charset chars', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRoomCode()).toMatch(CHARSET);
    }
  });
});
