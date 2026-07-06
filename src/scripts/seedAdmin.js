import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import getPrisma, { ensureConnected } from "../db/prisma.js";

dotenv.config();

/* Bootstrap (or reset) the first Super Admin.
   Configure via env: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME.
   Run: npm run seed:admin   (loads .env via --env-file) */
const email = (process.env.ADMIN_EMAIL || "admin@hoi.local").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "ChangeMe!123";
const name = process.env.ADMIN_NAME || "HOI Super Admin";

async function run() {
  await ensureConnected();
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await getPrisma().adminUser.findUnique({ where: { email } });
  if (existing) {
    await getPrisma().adminUser.update({
      where: { email },
      data: { passwordHash, role: "super_admin", active: true, name },
    });
    console.log(`Updated existing super admin: ${email}`);
  } else {
    await getPrisma().adminUser.create({
      data: { email, name, passwordHash, role: "super_admin", active: true },
    });
    console.log(`Created super admin: ${email}`);
  }
  console.log(`Password: ${password}`);
  console.log("Log in at the Super Admin panel with these credentials, then change the password.");
  process.exit(0);
}

run().catch((e) => {
  console.error("seedAdmin failed:", e.message);
  process.exit(1);
});
