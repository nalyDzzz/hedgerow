# Security

Hedgerow holds database passwords and runs SQL against servers you care about, so security reports are
taken seriously.

## Reporting a problem

Please report it privately, not in a public issue:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**, or open
   <https://github.com/nalyDzzz/hedgerow/security/advisories/new> directly.

Include what you found, how to reproduce it, and what an attacker could do with it. A minimal example helps
more than a long description.

This is a volunteer project, so reports are read and answered as time allows. You will be told when the
problem is confirmed and again when a fix is released, and you will be credited unless you would rather not
be.

## Supported versions

Only the latest release, and the `main` branch, receive security fixes.

## What is in scope

- Anything that exposes saved passwords or connection details. Passwords are encrypted with the operating
  system's credential storage and should never leave the main process.
- Anything that lets a web page, a query result or a database server run code on the user's machine or reach
  beyond the UI's sandbox.
- Anything that makes Hedgerow run SQL the user did not ask for.

A database server that returns hostile data is in scope. A user who runs destructive SQL on purpose is not.
