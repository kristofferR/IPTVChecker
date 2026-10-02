import { resolve } from "node:path";

const tauriCli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const environment = { ...process.env };

// Tauri's bundled linuxdeploy uses an old strip that cannot read RELR
// sections emitted by current Linux distributions such as Arch.
if (process.platform === "linux") {
  environment.NO_STRIP ??= "1";
}

// The MCP agent-control plugin is a dev-only Cargo feature. On Linux its
// screenshot dependency links PipeWire, so it needs those development files.
function canBuildMcp(): boolean {
  if (process.platform !== "linux") return true;
  try {
    return Bun.spawnSync(["pkg-config", "--exists", "libpipewire-0.3", "libspa-0.2"]).success;
  } catch {
    return false;
  }
}

const args = Bun.argv.slice(2);
if (args[0] === "dev") {
  if (canBuildMcp()) {
    args.splice(1, 0, "--features", "mcp");
  } else {
    console.warn(
      "Skipping the MCP dev plugin: PipeWire development files (libpipewire-0.3, libspa-0.2) were not found.",
    );
  }
}

const tauri = Bun.spawn([process.execPath, tauriCli, ...args], {
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await tauri.exited);
