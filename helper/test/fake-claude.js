#!/usr/bin/env node
'use strict';

const mode = process.env.FAKE_CLAUDE_MODE || 'legal';
if (process.argv.includes('--version')) {
  console.log('9.9.9 (Fake Claude)');
  process.exit(0);
}
const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]);
const ids = schema.properties.action.enum;
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_DUMP) require('fs').appendFileSync(process.env.FAKE_CLAUDE_DUMP, input + '\n=====\n');
  const reply = (action) => {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0001, usage: { input_tokens: 100, output_tokens: 10 }, structured_output: { action } }));
    process.exit(0);
  };
  if (mode === 'legal') reply(ids[ids.length - 1]);
  else if (mode === 'illegal') reply('move 9');
  else if (mode === 'retry') reply(input.includes('was not one of the legal actions') ? ids[0] : 'move 9');
  else if (mode === 'fail') process.exit(1);
  else if (mode === 'sleep') setTimeout(() => reply(ids[0]), 120000);
});
