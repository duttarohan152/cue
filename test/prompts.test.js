const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, CODING_GUIDANCE } = require('../src/prompts');

test('assist mode gives a direct answer in first person', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  // System prompt must instruct to answer in first person with no preamble
  assert.match(text, /first person/i);
  assert.match(text, /no preamble|preamble/i);
});

test('say mode produces a spoken answer not a question', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /say out loud|in first person/i);
  // Must instruct to write actual spoken words (not meta-instructions)
  assert.match(text, /actual words|Write the|2.5 sentences/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('leetcode mode answers as the candidate, not about them', () => {
  const system = MODES.leetcode.buildSystem(null);
  assert.match(system, /you are the candidate/i);
  assert.match(system, /first person/i);
});

test('coding guidance opens with thinking out loud, one point per line', () => {
  assert.match(CODING_GUIDANCE, /first person/i);
  assert.match(CODING_GUIDANCE, /one point per line/i);
  // The bullet marker is load-bearing: the renderer folds consecutive plain
  // lines back into one paragraph, so only a bullet survives as its own line.
  assert.match(CODING_GUIDANCE, /starting with "- "/);
  assert.match(CODING_GUIDANCE, /never write this section as a paragraph/i);
});

test('coding guidance keeps the solution simple', () => {
  assert.match(CODING_GUIDANCE, /clever one-liners/i);
  assert.match(CODING_GUIDANCE, /over-engineering/i);
  assert.match(CODING_GUIDANCE, /time and space complexity/i);
});

test('coding guidance closes on the two complexity bullets', () => {
  assert.match(CODING_GUIDANCE, /T\(n\)/);
  assert.match(CODING_GUIDANCE, /S\(n\)/);
  assert.match(CODING_GUIDANCE, /nothing at all after them/i);
});

test('coding guidance stays inert for answers without code', () => {
  // assist and ask append this to every answer, so a behavioural reply must not
  // get pushed into the code structure or grow complexity lines.
  assert.match(CODING_GUIDANCE, /when your response includes a code solution/i);
});

test('followup mode returns a bullet list', () => {
  const system = MODES.followup.buildSystem(null);
  assert.match(system, /bullet list|bullets/i);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});
