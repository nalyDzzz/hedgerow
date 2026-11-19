# SQL Management Editor

An open-source desktop SQL client for Windows, macOS and Linux. No paid tier, no locked features.

The name is a working title. The project is early: MySQL works today, and the driver layer is built so
PostgreSQL, SQLite and others can be added without touching the UI.

## What works

- Saved connections, with passwords encrypted by the operating system's keychain
- A schema tree: databases, tables, views, columns and keys
- A SQL editor with MySQL syntax, schema-aware autocomplete and multiple tabs
- Run the statement under the cursor, the selection, or the whole tab; stop a running statement
- A results grid that stays fast on large results, with resizable columns and keyboard navigation
- A value panel that formats JSON, including JSON stored in text columns, without altering numbers
- A color per connection that tints the window, so production never looks like local
- Light and dark themes

Values are shown exactly as stored: large integers and decimals keep every digit, and dates are not
shifted into your timezone.

## Run it

You need [Node.js](https://nodejs.org) 24 and [pnpm](https://pnpm.io) 11, the versions it is developed on.

```sh
pnpm install
pnpm dev
```

`pnpm dev` opens the app with hot reload. `pnpm build` produces the production bundle in `out/`, and
`pnpm start` runs that bundle.

The repository pins its pnpm version in `package.json`. An older pnpm 11 switches to it by itself; pnpm
11.11 on its own hangs while installing.

### Build an installer

```sh
pnpm dist
```

This builds an installer for the operating system you run it on and puts it in `dist/`: an `.exe` setup on
Windows, a `.dmg` on macOS, an AppImage on Linux. `pnpm package` builds the app unpacked instead, which is
quicker when you only want to try the packaged build.

Only the Windows build has been tested so far. The builds are not code-signed yet, so Windows shows a
SmartScreen warning before running the installer, and macOS will refuse to open the app until it is signed
and notarized.

### A database to try it on

```sh
docker run -d --name sme-mysql-dev -e MYSQL_ROOT_PASSWORD=devpass -p 127.0.0.1:3307:3306 mysql:8.4
docker exec -i sme-mysql-dev mysql -uroot -pdevpass < dev/sample-data.sql
```

Then add a connection to `127.0.0.1`, port `3307`, user `root`, password `devpass`. The sample data is a
small shop: customers, products and 2,500 orders with JSON columns.

## Checks

```sh
pnpm typecheck
pnpm test
```

The driver tests run against a real server and are skipped unless you point them at one:

```sh
TEST_MYSQL_PORT=3307 TEST_MYSQL_PASSWORD=devpass pnpm test
```

## How it is put together

The app is [Electron](https://www.electronjs.org) with TypeScript throughout.

| Folder | What lives there |
| --- | --- |
| `src/shared` | Types shared by every process: the driver contract and the API the UI calls |
| `src/drivers` | One folder per database. Plain Node code, no Electron |
| `src/main` | The main process: window, saved connections, and the bridge to the drivers |
| `src/preload` | Exposes the API to the UI as `window.api` |
| `src/renderer` | The UI: React, Tailwind, CodeMirror, TanStack Table |

Database connections live in a separate process (`src/main/driver-host.ts`), so a slow query or a huge
result never freezes the window. The UI has no direct access to Node or to passwords.

## Adding a database

1. Add the id to `DriverId` and `DRIVER_INFO` in `src/shared/driver.ts`.
2. Implement the `Driver` interface from that file in `src/drivers/<id>/index.ts`. `src/drivers/mysql` is the
   reference.
3. Register it in `src/drivers/index.ts`.

A driver returns plain data only: strings, numbers, `null`, and a small summary object for binary values.
Return anything that would lose precision as a string.

## License

Copyright (C) 2026 the SQL Management Editor contributors.

Licensed under the [GNU General Public License, version 3](LICENSE). You are free to use, study, change and
share this program. If you distribute it, changed or not, you must do so under the same license and make the
source available. It comes with no warranty.
