import { useEffect, useState } from "react";

export function useLanIp(): string {
  const [host, setHost] = useState("localhost:5173");

  useEffect(() => {
    fetch("/api/system/lan-ip", { credentials: "include" })
      .then((r) => r.json())
      .then(({ ip, port }: { ip: string; port: number }) => {
        setHost(`${ip}:${port}`);
      })
      .catch(() => {});
  }, []);

  return host;
}
