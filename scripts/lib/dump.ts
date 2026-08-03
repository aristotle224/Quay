import { createClient, type Client, type InValue } from "@libsql/client";

/**
 * Table-agnostic dump/restore: reads `sqlite_master` for the table list
 * rather than hardcoding table names, so this keeps working as the schema
 * evolves (e.g. issue 3.4 adding KYC columns) without changes here.
 */

export type TableDump = Record<string, unknown>[];

export type DatabaseDump = {
  createdAt: string;
  /** table name -> array of row objects, in `SELECT *` column order. */
  tables: Record<string, TableDump>;
};

export type DumpManifest = {
  createdAt: string;
  /** table name -> row count, for a quick eyeball/verification without decrypting the full payload. */
  rowCounts: Record<string, number>;
};

async function listTables(client: Client): Promise<string[]> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return result.rows.map((row) => String(row["name"]));
}

export async function dumpDatabase(databaseUrl: string, authToken?: string): Promise<DatabaseDump> {
  const client = createClient({ url: databaseUrl, authToken });
  try {
    const tableNames = await listTables(client);
    const tables: Record<string, TableDump> = {};

    for (const table of tableNames) {
      // Table names come from sqlite_master, not user input, but quoting
      // defensively costs nothing and avoids relying on that distinction.
      const result = await client.execute(`SELECT * FROM "${table}"`);
      tables[table] = result.rows.map((row) =>
        Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
      );
    }

    return { createdAt: new Date().toISOString(), tables };
  } finally {
    client.close();
  }
}

export function manifestOf(dump: DatabaseDump): DumpManifest {
  const rowCounts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(dump.tables)) {
    rowCounts[table] = rows.length;
  }
  return { createdAt: dump.createdAt, rowCounts };
}

export type RestoreResult = {
  /** table name -> rows actually inserted, for comparison against the dump's manifest. */
  rowCounts: Record<string, number>;
};

/**
 * Restores a dump into `databaseUrl`. The caller is responsible for having
 * already recreated the schema there (see `bootstrap()` in
 * `apps/api/src/db/client.ts`) - this only inserts rows into tables that
 * already exist, and skips (with a warning, not silently) any table in the
 * dump that the target database doesn't have.
 */
export async function restoreDatabase(
  databaseUrl: string,
  authToken: string | undefined,
  dump: DatabaseDump,
): Promise<RestoreResult> {
  const client = createClient({ url: databaseUrl, authToken });
  try {
    const targetTables = new Set(await listTables(client));
    const rowCounts: Record<string, number> = {};

    for (const [table, rows] of Object.entries(dump.tables)) {
      if (!targetTables.has(table)) {
        console.warn(
          `[db-restore] Skipping table "${table}" from the dump - it doesn't exist in the target ` +
            `database. Run bootstrap()/db:push against the target first if this is unexpected.`,
        );
        continue;
      }

      let inserted = 0;
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const placeholders = columns.map(() => "?").join(", ");
        const columnList = columns.map((c) => `"${c}"`).join(", ");
        await client.execute({
          sql: `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`,
          // `row` came from this same database's own `SELECT *` (dumped as JSON,
          // then parsed back) - every value is trusted to already be a valid
          // libSQL bind value. Note: a BLOB column would round-trip through
          // JSON incorrectly (this schema has none today - see BOOTSTRAP_SQL in
          // apps/api/src/db/client.ts, TEXT/INTEGER only); revisit if one is added.
          args: columns.map((c) => row[c] as InValue),
        });
        inserted += 1;
      }
      rowCounts[table] = inserted;
    }

    return { rowCounts };
  } finally {
    client.close();
  }
}
