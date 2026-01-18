import { sql } from "drizzle-orm";
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";

export const deviceSettings = sqliteTable(
	"deviceSettings",
	{
		id: integer("id").primaryKey().notNull().default(1),
		mdnsCounter: integer("mdns_counter").notNull().default(0)
	},
	table => [
		check("id_check_singleton", sql`${table.id} = 1`)
	]
);
