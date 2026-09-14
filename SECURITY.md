# Security policy

## Supported versions

Security fixes target the latest stable release of Moirai. If you use an older release, upgrade to receive fixes. Before the first stable release, fixes target `main`. Prereleases do not have a separate security maintenance commitment.

## Report a vulnerability

Please [report vulnerabilities privately through GitHub](https://github.com/moiraitv/moirai/security/advisories/new). Do not post vulnerability details in public issues, discussions, or pull requests.

Include:

- The affected Moirai version, commit, or container image digest.
- How you installed Moirai and any relevant configuration.
- Steps to reproduce the problem, with a small example if possible.
- The likely impact and any access needed to reproduce it.

Remove credentials, tokens, personal information, and private media from examples and logs before sharing them.

If the private reporting form is unavailable, [open an issue](https://github.com/moiraitv/moirai/issues) asking for a private security contact **without including vulnerability details**. Wait for a private reporting channel before sharing your findings.

## Response and disclosure

We review reports on a best-effort basis and use the private report to discuss findings, fixes, and disclosure. Please coordinate public disclosure with the maintainers so users have an opportunity to update. We cannot promise response times, fix dates, or rewards.

## Testing and access

Test only installations you own or have permission to assess. Avoid accessing other users' data or disrupting services.

Moirai's sign-in protects administration. Playback endpoints intentionally allow unauthenticated viewing; operators can restrict who reaches them through network access controls. See [Administrator access](apps/docs/src/getting-started/access.md) for the intended behavior. Reports of unexpected access or other security weaknesses are welcome.
