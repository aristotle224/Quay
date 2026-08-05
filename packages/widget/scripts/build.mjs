import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const entryFile = path.resolve(rootDir, "src/index.ts");
const outFile = path.resolve(distDir, "widget.js");
const webPublicFile = path.resolve(rootDir, "../../apps/web/public/widget.js");

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

async function build() {
  console.log("Building @checkout/widget IIFE bundle...");

  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "Quay",
    target: "es2020",
    outfile: outFile,
  });

  const content = fs.readFileSync(outFile);
  const rawSize = content.length;
  const gzippedContent = zlib.gzipSync(content);
  const gzippedSize = gzippedContent.length;

  const MAX_GZIPPED_SIZE = 5120; // 5 KB hard budget

  console.log(`Build completed:`);
  console.log(`  Raw size:     ${(rawSize / 1024).toFixed(2)} KB (${rawSize} bytes)`);
  console.log(`  Gzipped size: ${(gzippedSize / 1024).toFixed(2)} KB (${gzippedSize} bytes)`);
  console.log(`  Budget limit: ${(MAX_GZIPPED_SIZE / 1024).toFixed(2)} KB (5120 bytes)`);

  if (gzippedSize > MAX_GZIPPED_SIZE) {
    console.error(`❌ FAILURE: Widget bundle size (${gzippedSize} B) exceeds hard budget limit of 5 KB (${MAX_GZIPPED_SIZE} B)!`);
    process.exit(1);
  }

  console.log(`✓ Size budget passed (${gzippedSize} B <= 5120 B)`);

  // Ensure target directory exists for apps/web/public
  const webPublicDir = path.dirname(webPublicFile);
  if (!fs.existsSync(webPublicDir)) {
    fs.mkdirSync(webPublicDir, { recursive: true });
  }

  fs.copyFileSync(outFile, webPublicFile);
  console.log(`✓ Copied bundle to ${webPublicFile}`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
