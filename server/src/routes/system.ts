import { Router } from "express";
import { networkInterfaces } from "os";

export const systemRouter = Router();

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

// GET /api/system/lan-ip
systemRouter.get("/lan-ip", (_req, res) => {
  res.json({ ip: getLanIp(), port: Number(process.env.PORT ?? 3001) });
});
