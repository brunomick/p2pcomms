// Keeps a literal `</script` in the bundle from ending the inline <script> early.
export function escapeScriptEnd(code) {
  return code.replace(/<\/script/gi, (m) => `<\\/${m.slice(2)}`);
}
