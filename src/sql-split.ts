// Pure SQL statement splitter — no config/db imports so it's trivially testable.
//
// Split on ';' but NOT inside $$-dollar-quoted blocks. DO $$ ... $$ migration
// blocks (idempotent ALTER ADD COLUMN) contain internal semicolons; a naive
// split(";") shreds them so the ALTERs silently never run. Track $$ depth.
export function splitSqlStatements(text: string): string[] {
  const out: string[] = []
  let buf = ""
  let inDollar = false
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "$") {
      inDollar = !inDollar
      buf += "$$"
      i++
      continue
    }
    if (text[i] === ";" && !inDollar) {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      continue
    }
    buf += text[i]
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
