// Pure SQL statement splitter — no config/db imports so it's trivially testable.
//
// Split on ';' but NOT inside $$-dollar-quoted blocks. DO $$ ... $$ migration
// blocks (idempotent ALTER ADD COLUMN) contain internal semicolons; a naive
// split(";") shreds them so the ALTERs silently never run.
//
// Also skips `-- line comments`: a `$$` or `;` inside a comment must not toggle
// the dollar state or split a statement (a stray `$$` in a comment desyncs the
// toggle and shreds the very DO block the comment describes).
export function splitSqlStatements(text: string): string[] {
  const out: string[] = []
  let buf = ""
  let inDollar = false
  let i = 0
  while (i < text.length) {
    // -- line comment (only meaningful outside a $$ block): copy verbatim to EOL.
    if (!inDollar && text[i] === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i)
      const end = nl === -1 ? text.length : nl
      buf += text.slice(i, end)
      i = end
      continue
    }
    if (text[i] === "$" && text[i + 1] === "$") {
      inDollar = !inDollar
      buf += "$$"
      i += 2
      continue
    }
    if (text[i] === ";" && !inDollar) {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      i++
      continue
    }
    buf += text[i]
    i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
