import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // スマホから LAN 越しに dev サーバーへアクセスする場合、
  // 警告が出たらここに PC の IP を追加: allowedDevOrigins: ["192.168.0.10"],
};

export default nextConfig;
