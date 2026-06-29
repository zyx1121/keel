import { test, expect } from "bun:test"
import { splitSqlStatements } from "../sql-split.ts"

// Regression: a naive MIGRATION.split(";") shredded DO $$ ... $$ blocks (their
// internal semicolons split mid-block), so idempotent ALTER ADD COLUMN migrations
// silently never ran. splitSqlStatements must keep $$ blocks intact.

test("keeps DO $$ blocks intact (internal ; not split)", () => {
  const sql = `CREATE TABLE a (id int);
DO $$ BEGIN IF true THEN ALTER TABLE a ADD COLUMN x text; END IF; END $$;
CREATE INDEX i ON a (x);`
  const stmts = splitSqlStatements(sql)
  expect(stmts.length).toBe(3)
  expect(stmts[1]).toContain("DO $$")
  expect(stmts[1]).toContain("END $$")
  expect(stmts[1]).toContain("ADD COLUMN x text")
})

test("splits top-level statements", () => {
  expect(splitSqlStatements("SELECT 1; SELECT 2;").length).toBe(2)
})

test("DO block with multiple internal semicolons stays one statement", () => {
  expect(splitSqlStatements(`DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;`).length).toBe(1)
})

test("ignores trailing whitespace-only fragments", () => {
  expect(splitSqlStatements("SELECT 1;   ;  ").length).toBe(1)
})

// Regression for the actual bug: a stray $$ in a -- comment desynced the toggle
// and shredded the DO block it described.
test("a $$ inside a -- comment does not desync the toggle", () => {
  const sql = `-- idempotent via DO $$
DO $$ BEGIN ALTER TABLE a ADD COLUMN x text; END $$;
SELECT 2;`
  const stmts = splitSqlStatements(sql)
  expect(stmts.length).toBe(2)
  expect(stmts[0]).toContain("ADD COLUMN x text")
  expect(stmts[0]).toContain("END $$")
})

test("a ; inside a -- comment does not split", () => {
  expect(splitSqlStatements("SELECT 1; -- a ; b ; c\nSELECT 2;").length).toBe(2)
})
