import "temporal-polyfill/full/global";
import postgres from "@prisma/orm-postgres/runtime";
import contractJson from "./contract.json" with { type: "json" };
export const db = postgres({
    contractJson,
    url: process.env.DATABASE_URL,
});
