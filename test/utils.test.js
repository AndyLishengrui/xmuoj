const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage, contestStatus, normalizeOutput, finalVerdict } = require('../out/utils.js');

test('detectLanguage supports required languages', () => {
  assert.equal(detectLanguage('/tmp/main.c'), 'C');
  assert.equal(detectLanguage('/tmp/main.cpp'), 'C++');
  assert.equal(detectLanguage('/tmp/Main.java'), 'Java');
  assert.equal(detectLanguage('/tmp/main.py'), 'Python3');
  assert.equal(detectLanguage('/tmp/main.txt'), undefined);
});

test('contestStatus returns expected states', () => {
  const now = new Date('2026-01-01T10:00:00Z');
  assert.equal(contestStatus(now, '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'), '准备中');
  assert.equal(contestStatus(now, '2026-01-01T09:00:00Z', '2026-01-01T12:00:00Z'), '进行中');
  assert.equal(contestStatus(now, '2026-01-01T07:00:00Z', '2026-01-01T09:00:00Z'), '已结束');
});

test('normalizeOutput trims ending newline differences', () => {
  assert.equal(normalizeOutput('a\r\nb\r\n'), 'a\nb');
});

test('finalVerdict marks terminal statuses', () => {
  assert.equal(finalVerdict('Accepted'), true);
  assert.equal(finalVerdict('Judging'), false);
});
