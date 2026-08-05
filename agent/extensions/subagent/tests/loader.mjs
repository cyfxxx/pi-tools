// Test loader: resolves @earendil-works/* and typebox to the real pi SDK packages.
// Usage: node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { register } from "node:module";

function detectSdkBase() {
  if (process.env.PI_SDK_PATH) return process.env.PI_SDK_PATH;
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const candidate = pathResolve(root, "@earendil-works/pi-coding-agent");
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through to legacy default */
  }
  return "/root/.local/share/pi-node/node-v22.23.1-linux-arm64/lib/node_modules/@earendil-works/pi-coding-agent";
}

const SDK_BASE = detectSdkBase();

function pkgBaseDir(pkgName) {
	return pkgName === "@earendil-works/pi-coding-agent" ? SDK_BASE : pathResolve(SDK_BASE, "node_modules", pkgName);
}

export async function resolve(specifier, context, next) {
	if (specifier === "typebox" || specifier.startsWith("@earendil-works/")) {
		const pkgName = specifier;
		const pkgDir = pkgBaseDir(pkgName);
		let pkgJson;
		try {
			const { readFile } = await import("node:fs/promises");
			pkgJson = JSON.parse(await readFile(pathResolve(pkgDir, "package.json"), "utf8"));
		} catch {
			return next(specifier, context);
		}
		const exportsMap = pkgJson.exports;
		let target = null;
		if (exportsMap && exportsMap["."] && exportsMap["."].import) {
			target = exportsMap["."].import;
		} else if (exportsMap && exportsMap["."]) {
			target = exportsMap["."];
		} else if (pkgJson.main) {
			target = pkgJson.main;
		} else if (pkgJson.module) {
			target = pkgJson.module;
		}
		const full = target && pathResolve(pkgDir, target);
		if (full && existsSync(full)) {
			return next(new URL(`file://${full}`).href, context);
		}
	}
	return next(specifier, context);
}

register(new URL("./loader.mjs", import.meta.url), import.meta.url);
