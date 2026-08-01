// Test loader: resolves @earendil-works/* and typebox to the real pi SDK packages.
// Usage: node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

const SDK_BASE = process.env.PI_SDK_PATH || "/root/.local/share/pi-node/node-v22.23.1-linux-arm64/lib/node_modules/@earendil-works/pi-coding-agent";

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
