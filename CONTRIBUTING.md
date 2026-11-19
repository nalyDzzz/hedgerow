# Contributing to Hedgerow

Hedgerow is built in the open and help is welcome: bug reports, ideas, fixes, and above all new database
drivers.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug.** Open an issue with what you did, what you expected and what happened. The bug report
  form asks for the details that are usually needed.
- **Suggest a feature.** Open an issue describing the problem you want solved, not only the solution.
- **Add a database.** The driver layer exists so that PostgreSQL, SQLite and others can be added without
  touching the UI. See [Adding a database](README.md#adding-a-database).
- **Pick something from the roadmap.** The [README](README.md#roadmap) lists what is planned.

Before starting anything large, open an issue first. It avoids two people building the same thing, and a
design problem is cheaper to find in a conversation than in a finished pull request.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Set up

You need [Node.js](https://nodejs.org) 24 and [pnpm](https://pnpm.io). The repository pins its pnpm version,
and pnpm switches to it by itself.

```sh
pnpm install
pnpm dev
```

For a database to work against, start MySQL in Docker and load the sample data:

```sh
docker run -d --name hedgerow-mysql-dev -e MYSQL_ROOT_PASSWORD=devpass -p 127.0.0.1:3307:3306 mysql:8.4
docker exec -i hedgerow-mysql-dev mysql -uroot -pdevpass < dev/sample-data.sql
```

## Before you open a pull request

Run the same checks CI runs:

```sh
pnpm typecheck
TEST_MYSQL_PORT=3307 TEST_MYSQL_PASSWORD=devpass pnpm test
pnpm build
```

The driver tests talk to a real server and are skipped without `TEST_MYSQL_PORT`, so set it.

A pull request is easier to review, and merges sooner, when it:

- does one thing; unrelated cleanups go in their own pull request
- says what changed and why, and how you checked it
- includes a screenshot if it changes the UI
- adds or updates tests when it changes a driver

## What reviewers look for

These are the ideas the project is built on. A change that goes against one of them needs a good reason.

1. **Values are shown exactly as stored.** No rounding, no timezone shifts, no reformatting of numbers
   inside JSON. If a value cannot be represented exactly as a JavaScript number, a driver returns it as text.
2. **The UI never touches the database or the file system.** It calls `window.api`, which is declared in
   `src/shared/api.ts`. Passwords stay in the main process.
3. **Connections live in the driver process.** A slow query must never freeze the window.
4. **The window chrome is neutral.** The only strong color is the color of the active connection, so that
   color always means "this is where you are".
5. **No paid tier, no locked features.** Hedgerow exists because other tools put features behind a paywall.

## How the code is organized

The [README](README.md#how-it-is-put-together) has a map of the folders. The contract every driver
implements is `src/shared/driver.ts`, and `src/drivers/mysql` is the reference implementation.

## License

Hedgerow is licensed under the [GNU General Public License, version 3](LICENSE). By contributing, you agree
that your contribution is licensed under the same terms.
