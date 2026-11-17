# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue:
**[Report a vulnerability](https://github.com/dm807cam/papertie/security/advisories/new)**
(GitHub's private vulnerability reporting, under the repository's **Security** tab).

Say what you found, how to reproduce it, and which version and system you used. A board file or
a `.papertie` export that triggers the problem helps; make a small one that holds nothing of
your own.

You will get an answer in the advisory thread. Papertie is maintained by volunteers, so there is
no guaranteed response time, but reports are read and fixes are released as new versions.

## Supported versions

Only the [latest release](https://github.com/dm807cam/papertie/releases/latest) receives
fixes.

## What to expect of Papertie

Papertie is a local desktop app: no account, no server, no open network port. Its one network
request is the daily update check against GitHub's releases API, which can be turned off. What
it defends against, and what it does not, is written down in
[docs/security/threat-model.md](docs/security/threat-model.md).

The packages are not code-signed yet. Check a download against the release's `SHA256SUMS`.
