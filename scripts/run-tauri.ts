import { resolve } from "node:path";

const tauriCli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const environment = { ...process.env };

// Tauri's bundled linuxdeploy uses an old strip that cannot read RELR
// sections emitted by current Linux distributions such as Arch.
if (process.platform === "linux") {
  environment.NO_STRIP ??= "1";
}

const args = Bun.argv.slice(2);
// The MCP agent-control plugin is a dev-only Cargo feature.
if (args[0] === "dev") args.splice(1, 0, "--features", "mcp");

const tauri = Bun.spawn([process.execPath, tauriCli, ...args], {
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await tauri.exited);
