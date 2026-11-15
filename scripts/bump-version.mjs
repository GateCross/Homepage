import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "../package.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const currentVersion = pkg.version || "0.2.0";

// 解析为语义化版本三段式并递增 patch 位
const parts = currentVersion.split(".").map((n) => parseInt(n, 10) || 0);
while (parts.length < 3) {
  parts.push(0);
}
parts[2] += 1;
const nextVersion = parts.join(".");

pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
console.log(`[bump-version] 版本号已从 ${currentVersion} 升级为 ${nextVersion}`);
