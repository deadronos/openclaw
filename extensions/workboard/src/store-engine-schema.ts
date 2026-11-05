import {
  postgresIndexOrderingMigration,
  withLegacyPostgresIndexOrdering,
  type StoreSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { WORKBOARD_POSTGRES_SCHEMA_SQL } from "./workboard-postgres-schema.js";
import { SCHEMA_VERSION, WORKBOARD_SCHEMA_SQL } from "./workboard-schema.js";

const VERDICT_COLUMN_LINE =
  /\n {2}"(?:review_json|closure_reason|acceptance|accepted_by)" text COLLATE "C",|\n {2}"accepted_at" bigint,/g;
const EVENT_OWNER_COLUMN_LINE = /\n {2}"owner_id" text COLLATE "C",/g;

/** Version 4 carried no review verdict columns and no released-event owner. */
const withoutVerdictColumns = (sql: string) =>
  sql.replace(VERDICT_COLUMN_LINE, "").replace(EVENT_OWNER_COLUMN_LINE, "");
const WORKBOARD_POSTGRES_SCHEMA_V4_SQL = withoutVerdictColumns(WORKBOARD_POSTGRES_SCHEMA_SQL);
// Fail fast if the regex stops matching: a leaked column would make the v4 snapshot silently wrong.
const LEAKED_V4_COLUMN = [
  "review_json",
  "closure_reason",
  "acceptance",
  "accepted_by",
  "accepted_at",
  "owner_id",
].find((column) => WORKBOARD_POSTGRES_SCHEMA_V4_SQL.includes(`"${column}"`));
if (LEAKED_V4_COLUMN) {
  throw new Error(
    `workboard v4 postgres DDL derivation is stale: ${LEAKED_V4_COLUMN} leaked into the v4 snapshot — update VERDICT_COLUMN_LINE or the DDL formatting`,
  );
}

export const workboardEngineSchema: StoreSchema = {
  id: "workboard",
  version: SCHEMA_VERSION,
  sqlite: WORKBOARD_SCHEMA_SQL,
  postgres: WORKBOARD_POSTGRES_SCHEMA_SQL,
  postgresMigrations: [
    {
      version: 4,
      fromSchema: {
        postgres: withLegacyPostgresIndexOrdering(WORKBOARD_POSTGRES_SCHEMA_V4_SQL),
      },
      schema: { postgres: WORKBOARD_POSTGRES_SCHEMA_V4_SQL },
      sql: postgresIndexOrderingMigration(WORKBOARD_POSTGRES_SCHEMA_SQL),
    },
    {
      version: 5,
      fromSchema: { postgres: WORKBOARD_POSTGRES_SCHEMA_V4_SQL },
      schema: { postgres: WORKBOARD_POSTGRES_SCHEMA_SQL },
      sql: `ALTER TABLE "workboard_cards"
  ADD COLUMN IF NOT EXISTS "review_json" text COLLATE "C",
  ADD COLUMN IF NOT EXISTS "closure_reason" text COLLATE "C",
  ADD COLUMN IF NOT EXISTS "acceptance" text COLLATE "C",
  ADD COLUMN IF NOT EXISTS "accepted_by" text COLLATE "C",
  ADD COLUMN IF NOT EXISTS "accepted_at" bigint;
ALTER TABLE "workboard_card_events" ADD COLUMN IF NOT EXISTS "owner_id" text COLLATE "C";`,
    },
  ],
};
