import { resolve } from "node:path";

const tauriCli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const environment = { ...process.env };

// Tauri's bundled linuxdeploy uses an old strip that cannot read RELR
// sections emitted by current Linux distributions such as Arch.
if (process.platform === "linux") {
  environment.NO_STRIP ??= "1";
}

const tauri = Bun.spawn([process.execPath, tauriCli, ...Bun.argv.slice(2)], {
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await tauri.exited);
