declare const process: {
  env: Record<string, string | undefined>;
};

import { definePrismaConfig } from "prisma/config";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import "dotenv/config";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",

    db: {
      connection: process.env["DATABASE_URL"]!,
    },
  }),
});