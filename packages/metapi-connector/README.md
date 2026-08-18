# metapi-connector

Local-first Connector for r-api. It observes and controls the official Codex managed App Server, reports privacy-safe session metadata, delivers durable completion notifications, and bridges Feishu prompts and approvals back to the original Codex session.

## Install

```bash
npm install --global metapi-connector
metapi-connector --version
metapi-connector --help
```

Node.js 22.15 or later is required.

## Pair And Install

```bash
metapi-connector pair \
  --server https://gateway.example.com \
  --pairing-id '<pairing-id>' \
  --pairing-token '<pairing-token>'

metapi-connector install-service \
  --connector-launchd-label com.metapi.localconnector.default
```

`install-service` is the normal macOS path. It installs or upgrades two LaunchAgents from the standalone npm package:

- The Connector runs in `--direct` mode against the official managed Codex App Server.
- The configuration watcher reloads the App Server and Connector when `auth.json` or `config.toml` changes.

Existing plist files are backed up under the Connector data directory. New plist files are validated before either service is stopped, and a failed upgrade restores and reloads the previous services. The installer rejects repository `dist` entries so a persistent service cannot silently depend on a temporary checkout.

In another terminal, verify the complete control path and open the local dashboard:

```bash
metapi-connector doctor
metapi-connector dashboard --open
```

`doctor` exits with status `0` only when the local Connector process, CLI/runtime versions, dashboard, App Server control connection, session snapshot upload, and r-api heartbeat are all ready. `status` prints the same evidence as JSON without converting it into pass/fail checks. A status query never overwrites the version or capabilities reported by the running Connector.

The dashboard prefers `http://127.0.0.1:4765/`, but automatically falls forward when that port is occupied. `dashboard` reads the private runtime discovery file and prints the actual URL. Do not hard-code port 4765 in local shortcuts.

Use command-specific help for the complete option list:

```bash
metapi-connector pair --help
metapi-connector run --help
metapi-connector status --help
metapi-connector doctor --help
metapi-connector dashboard --help
metapi-connector install-service --help
metapi-connector uninstall-service --help
```

After upgrading the npm package, rerun the same `install-service` command. It rewrites both LaunchAgents to the currently installed package path and verifies the complete session-control path. It does not restart Codex Desktop. Durable local queues resume pending notifications and Feishu prompts after Connector or App Server reloads.

For foreground development only, use `metapi-connector run --direct`. `--control-app-server` remains a compatibility alias for older scripts.

See the r-api repository documentation for pairing permissions, launchd setup, configuration reload, durable queues, Bridge continuation and Feishu interaction behavior.
