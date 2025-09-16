# Niagara Tools

Utility scripts that streamline the Niagara module development workflow.

## Development watcher

`niagara-watch` keeps your station and workbench processes in sync with changes to your Niagara modules. It launches both processes for you, watches for file updates, and restarts the station and workbench whenever a change is detected.

### Prerequisites

- Node.js 16 or newer
- `NIAGARA_HOME` environment variable pointing to your Niagara installation
- Install dependencies: `npm install`

### Usage

```bash
npm run watch-modules -- <station-name>
```

Or use the package binary directly (executes through [`tsx`](https://github.com/esbuild-kit/tsx)):

```bash
npx niagara-watch <station-name>
```

#### Options

- `--niagara-home <path>`: Override the `NIAGARA_HOME` directory.
- `-m, --modules <path>`: Directory containing Niagara modules to watch (defaults to `NIAGARA_HOME/modules` or `NIAGARA_MODULES_DIR`).
- `--workbench-cmd <cmd>`: Overrides the command used to start the workbench (default `wb`).
- `--station-cmd <cmd>`: Overrides the command used to start the station (default `station`).
- `--plat-cmd <cmd>`: (Deprecated) Kept for backward compatibility; station now stops by sending `quit` to its stdin.
- `--debounce <ms>`: Debounce interval before issuing restarts (default 5000ms).
- `--no-workbench`: Skip launching and managing the workbench process.

Environment variables `NIAGARA_STATION`, `NIAGARA_MODULES_DIR`, `NIAGARA_WORKBENCH_CMD`, `NIAGARA_STATION_CMD`, `NIAGARA_PLAT_CMD`, and `NIAGARA_DEBOUNCE_MS` provide the same overrides.

### Behaviour

1. Prepends `NIAGARA_HOME/bin` to `PATH`, ensuring Niagara CLI commands are available on every platform.
2. Launches the station (`station <station-name>`) and stops it gracefully by writing `quit` followed by the platform-specific newline (e.g. `\n` on Unix, `\r\n` on Windows) to the station process stdin. Previously this used `plat stop <station-name>`; that command is no longer invoked (auth not required).
3. Launches the workbench (`wb`) and restarts it by killing the process.
4. Watches the modules directory via [chokidar](https://github.com/paulmillr/chokidar). When files change, both processes are restarted.
5. Cleans up both processes on exit (Ctrl+C / SIGTERM).

### Notes

- The watcher automatically retries starting the workbench if it exits unexpectedly while the watcher is running.
- When the script asks the workbench to stop, it waits a few seconds before forcing termination (using `taskkill` on Windows or `SIGKILL` elsewhere).
