import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import getPrisma from "./db/prisma.js";

async function seed() {
  const prisma = getPrisma();

  let client = await prisma.client.findFirst({
    where: { email: "tufan.mandal@highoninnovation.com" },
  });

  if (!client) {
    client = await prisma.client.create({
      data: {
        name: "Tufan Mandal",
        studioName: "High On Innovation",
        email: "tufan.mandal@highoninnovation.com",
        plan: "growth",
        status: "active",
      },
    });
    console.log("✔ Client created:", client.id);
  } else {
    console.log("✔ Client already exists:", client.id);
  }

  const existing = await prisma.user.findUnique({
    where: { email: "tufan.mandal@highoninnovation.com" },
  });

  if (!existing) {
    const passwordHash = await bcrypt.hash("Tufan@123", 10);
    const user = await prisma.user.create({
      data: {
        clientId: client.id,
        name: "Tufan Mandal",
        email: "tufan.mandal@highoninnovation.com",
        passwordHash,
        role: "photographer",
      },
    });
    console.log("✔ User created:", user.email);
  } else {
    console.log("✔ User already exists:", existing.email);
  }

  await prisma.$disconnect();
  process.exit(0);
}

seed().catch((e) => { console.error(e); process.exit(1); });
