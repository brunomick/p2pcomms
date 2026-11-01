import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeScriptEnd } from '../../scripts/escape.mjs';

test('escapeScriptEnd rewrites </script so it cannot end the inline script', () => {
  const out = escapeScriptEnd('a="</script>";b="</SCRIPT >"');
  assert.equal(out, 'a="<\\/script>";b="<\\/SCRIPT >"');
  assert.ok(!/<\/script/i.test(out));
});
