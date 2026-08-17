import { prisma } from "./db.js";
const u = await prisma.user.update({ where: { id: 62 }, data: { role: "admin" } });
console.log(`Done — ${u.email} (id ${u.id}) is now admin`);
await prisma.$disconnect();
