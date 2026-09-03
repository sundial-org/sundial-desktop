# Contributing to Sundial Desktop

Thanks for your interest! A few things about how this repository works will save you time.

## How this repository is built

Sundial Desktop is developed inside a private monorepo alongside Sundial's cloud services. The open-source desktop surface is exported from there: each `Export from sundial@<sha>` commit replaces the whole tree with a fresh snapshot. That has two consequences:

- History here is one commit per export, not one per change.
- Pull requests that edit exported code cannot be merged directly, because the next export would overwrite them.

The exceptions are this `docs/` folder, the README, and its media. Those live in this repository and are edited here.

## Contributing code

We still want your fixes.

- Open an issue describing the bug or change first, ideally with a reproduction.
- Small patches: open the PR anyway. If we take it, we port it into the monorepo with credit (`Co-authored-by`), it flows back out in the next export, and we close the PR once the export containing it lands.
- Larger changes: talk to us in the issue or on [Discord](https://discord.gg/jHG5gDvyEQ) before writing code, so we can agree on an approach and make the port painless.

## Bug reports

Open an issue with your macOS version, the app version, and steps to reproduce. Screenshots or a short recording help a lot.

## Security

Please do not open public issues for vulnerabilities. Use GitHub's private vulnerability reporting (Security tab, "Report a vulnerability"). If that is unavailable, email matthew@sundial.md.

## Building from source

See the [Build](../README.md#build) section of the README.
