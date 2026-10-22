# setup-ktc-plugins

[![CI](https://github.com/Heapy/setup-ktc-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Heapy/setup-ktc-plugins/actions/workflows/ci.yml)

Restore and verify locked [Kotlin Toolchain source plugins](https://github.com/Heapy/ktc-plugins) in GitHub Actions.
Uses your committed launcher's pinned installer version, caches native binaries and source archives, then runs
`sync` and `verify`. Plugin sources are ready before Kotlin Toolchain loads the project.

## Usage

Commit the release launchers (`ktc-plugins` and `ktc-plugins.bat`), `ktc-plugins.yaml`, `ktc-plugins.lock.yaml`,
project configuration and managed ignore files. See the [installer guide](https://github.com/Heapy/ktc-plugins#install-a-plugin)
for initial installation. The action requires an existing installation with at least one plugin.

```yaml
name: Kotlin CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: Heapy/setup-ktc-plugins@v1
      - uses: Heapy/setup-ktc@v1
      - uses: Heapy/ktc-check@v1
```

Major tags are shown for readability; pin action commit SHAs for reproducible workflows.
Action versions and installer versions are independent. Upgrade the installer with its `wrapper update` command
and commit the result. This action uses the project launcher without rewriting it or updating plugin refs.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `working-directory` | `.` | Project directory within the checkout; also used as the CLI working directory |
| `cache` | `true` | Restore/save native binary and source archive caches |
| `cache-read-only` | `auto` | `auto` saves only on push, scheduled and manual runs; `true` restores only; `false` permits saving |
| `cache-key-suffix` | empty | Manually invalidate caches; up to 64 letters, digits, dots, underscores or hyphens |
| `sync` | `true` | Restore missing sources from the committed lockfile |
| `verify` | `true` | Check installed sources, declarations, lockfile and Git tracking/ignore state |
| `token` | `${{ github.token }}` | Token for accessing plugin repositories |

For vendored plugins, `sync: false` checks the committed sources without restoring missing files.
With both `sync: false` and `verify: false`, the action only bootstraps the pinned executable.
For private plugin repositories, supply a GitHub App token or fine-grained PAT with read access to those repositories;
the workflow token normally covers only its own repository. Treat private archive caches as private source content:
disable caching when the repository's cache readers should not have access to that source.

## Outputs

| Output | Meaning |
| --- | --- |
| `version` | Installer version pinned by the project launcher |
| `wrapper-path` | Absolute path to `ktc-plugins` or `ktc-plugins.bat` for the runner |
| `cache-hit` | `true` for an exact cache hit, `false` for a fallback, empty for a miss or when caching is disabled |

The action exports `KTC_PLUGINS_BINARY_CACHE` and `KTC_PLUGINS_CACHE_DIR` for subsequent steps. Continue using
`./ktc-plugins` from your project on Unix or `.\ktc-plugins.bat` in Windows PowerShell.

## Caching and reproducibility

Caches live outside the checkout under `RUNNER_TEMP`. Keys include the OS/architecture, normalized launcher contents,
manifest and lockfile hashes, and optional suffix. A fallback may reuse archives for the same launcher when the lockfile
changes; the CLI validates restored sources against the current lock. Cached executables are checksum-verified on every
launcher invocation. Project source trees and project locks are not cached.

All pull request events restore caches without saving by default. GitHub controls cache visibility between branches
and forks. Use ordinary `pull_request` workflows for contributions; do not execute untrusted checkout launchers under
`pull_request_target`. The action executes your committed launcher, just as a workflow shell step would.

Missing or stale lock entries, modified sources and corrupt binaries fail the job. `sync` does not advance moving
branches or tags. `KTC_PLUGINS_BINARY` overrides are rejected because they bypass launcher checksum verification.

## Runner support

| Platform | Tested runner |
| --- | --- |
| Linux x64, glibc | `ubuntu-24.04` |
| Linux ARM64, glibc | `ubuntu-24.04-arm` |
| macOS ARM64 | `macos-15` |
| Windows x64 | `windows-2025` |

Requires Node.js 22+, Bash, Git and curl, provided by the tested GitHub-hosted runners. Windows launchers use Windows
PowerShell. The native installer itself needs no JVM. Intel macOS, Windows ARM64 and Alpine/musl are unsupported.
The initial release is integration-tested with ktc-plugins 0.3.1. Launchers must use its published version/checksum format;
checkout development templates without release pins are rejected.

## Development

```sh
npm run check
npm test
npm run test:integration
```

No npm dependencies or bundling step. Integration tests use the published native installer and an exact locked BCV
source commit. They cover clean and offline restores, unchanged lockfiles, modified-source protection, stale locks,
and corrupted binary cache rejection. CI also executes the composite action on every supported runner.

Licensed under [Apache-2.0](LICENSE).
