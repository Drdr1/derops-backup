import prisma from "../db.server";

/** Uptime check for Caddy / monitoring: 200 when the DB answers. */
export const loader = async () => {
  await prisma.$queryRaw`SELECT 1`;
  return new Response("ok", { headers: { "Cache-Control": "no-store" } });
};
