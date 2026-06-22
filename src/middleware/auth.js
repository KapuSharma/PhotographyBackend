import jwt from "jsonwebtoken";

export default function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorised — no token" });
  }
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, clientId, email, role }
    next();
  } catch {
    return res.status(401).json({ message: "Unauthorised — invalid token" });
  }
}
