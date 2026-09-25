const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, CODING_GUIDANCE, EXPLANATION_GUIDANCE, codeLanguageDirective } = require('../src/prompts');

test('code language directive pins C and C++', () => {
  assert.match(codeLanguageDirective('c'), /write it in C\b/);
  assert.match(codeLanguageDirective('cpp'), /write it in C\+\+/);
});

test('code language directive infers for auto and for retired choices', () => {
  // Python/Bash were dropped from the selector; a value saved by an older build
  // must fall through to inference rather than pin a language nothing offers.
  for (const value of ['auto', 'python', 'bash', '', undefined]) {
    assert.match(codeLanguageDirective(value), /infer the most appropriate language/i);
  }
});

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

test('explanation guidance asks for crisp points, not paragraphs', () => {
  assert.match(EXPLANATION_GUIDANCE, /one point per line/i);
  assert.match(EXPLANATION_GUIDANCE, /starting with "- "/);
  assert.match(EXPLANATION_GUIDANCE, /never as paragraphs/i);
  assert.match(EXPLANATION_GUIDANCE, /first person/i);
  // Flat only: the renderer draws an indented bullet at the same level as a
  // top-level one, so a sub-bullet would read as a sibling point.
  assert.match(EXPLANATION_GUIDANCE, /no sub-bullets/i);
});

test('explanation guidance stays inert for code answers', () => {
  // assist and ask carry both blocks at once, so each has to be scoped by the
  // kind of answer or they would fight over the same response.
  assert.match(EXPLANATION_GUIDANCE, /when your answer explains rather than solves/i);
  assert.match(CODING_GUIDANCE, /when your response includes a code solution/i);
});

test('technical questions reach the explanation guidance', () => {
  for (const mode of ['assist', 'ask']) {
    const system = MODES[mode].buildSystem(null);
    assert.ok(system.includes(EXPLANATION_GUIDANCE), `${mode} must carry EXPLANATION_GUIDANCE`);
  }
  // leetcode is always a code answer; bulleted-prose rules would only confuse it.
  assert.ok(!MODES.leetcode.buildSystem(null).includes(EXPLANATION_GUIDANCE));
});

test('leetcode carries the conversation so spoken constraints reach it', () => {
  const transcript = [{ channel: 'them', text: 'Now do it in O(1) extra space.', ts: Date.now() }];
  const built = MODES.leetcode.build({ transcript, userText: '' });
  assert.match(built, /O\(1\) extra space/);
  assert.match(built, /Solve the coding problem shown in the screenshot/);
});

test('leetcode still works before anything has been heard', () => {
  const built = MODES.leetcode.build({ transcript: [], userText: '' });
  assert.match(built, /Solve the coding problem shown in the screenshot/);
  assert.ok(!/Conversation so far/.test(built), 'no empty conversation header');
});

test('only leetcode opts out of cue\'s answer history', () => {
  // Every press of Solve is a clean attempt at what is on screen now; the other
  // modes need continuity so a follow-up lands on the answer already given.
  assert.equal(MODES.leetcode.skipHistory, true);
  for (const name of ['assist', 'say', 'ask', 'followup', 'recap']) {
    assert.ok(!MODES[name].skipHistory, `${name} should receive answer history`);
  }
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
