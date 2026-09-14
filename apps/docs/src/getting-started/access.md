---
id: access.initial
title: Administrator access
description: Claim a new installation and understand the available sign-in methods.
contextual: true
---

# Administrator access

**Sign-in protects administration only. Viewing is not authenticated.** Viewers do not need a local account or an OIDC login to watch channels. Anyone who can reach the playback endpoints can view their streams, so use network access controls if viewing should be limited to particular people or devices.

Moirai supports signing in with either a **local account** (a username and password managed by Moirai) or an **OpenID Connect (OIDC) provider** such as **Logto**. OIDC lets you use an account managed by an external identity service. Logto is the only provider integration currently built into Moirai; other OIDC providers are not automatically interchangeable with it.

For local sign-in, the first person to open a new Moirai installation creates its administrator account. Enter a username and a long, unique password on the setup screen. After setup, the same screen becomes the normal sign-in page.

![The first-run administrator setup screen](/screenshots/administrator-setup.png)

When an operator has configured Logto, choose **Sign In with Logto** to authenticate through that provider. Local credentials can coexist with provider sign-in and remain useful as a fallback unless they are deliberately removed. Provider users accepted for the Moirai application receive the same full access as the local administrator.

If local credentials are lost, use the single-use recovery command described in [Account and recovery](/operations/account-and-recovery). Do not expose an uninitialized installation to the internet: another visitor could claim it first.

## Set up Logto

Create a **Traditional web** application in Logto. Set the following environment values for Moirai using the values from that application:

| Setting | Value |
| --- | --- |
| `MOIRAI_LOGTO_ENDPOINT` | Your Logto tenant's HTTPS origin, such as `https://your-tenant.logto.app`. |
| `MOIRAI_LOGTO_APP_ID` | The application's identifier. |
| `MOIRAI_LOGTO_APP_SECRET` | The application's secret. Keep it outside version control. |

Set all three values together. With Docker Compose, add them under `environment` in the Moirai service and recreate the container after saving. See [Configuration reference](/operations/configuration) for how environment settings are loaded.

Configure these URLs in Logto, replacing `https://moirai.example.com` with your Moirai address:

| Logto setting              | Value                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| Redirect URI               | `https://moirai.example.com/api/v1/auth/logto/callback`           |
| Post sign-out redirect URI | `https://moirai.example.com/login`                                |
| Backchannel logout URI     | `https://moirai.example.com/api/v1/auth/logto/backchannel-logout` |
| Is session required?       | Yes                                                               |
| Allow token exchange       | No                                                                |

Use exact URLs. The redirect and backchannel URLs use `MOIRAI_PUBLIC_URL`; the post sign-out URL uses `MOIRAI_MANAGEMENT_URL`. These normally match. For local development, they can use different ports, but the scheme and hostname must match.

Logto must be able to reach the backchannel logout URL. A cloud-hosted Logto tenant cannot call a localhost or private-network address. Session identifiers let Moirai sign out the specific session named by a logout notification; notifications without a session identifier can sign out that user's provider sessions. Token exchange is unnecessary for Moirai's sign-in flow.

Once configured, choose **Sign In with Logto** on Moirai's sign-in screen. Limit who can access the Logto application: every accepted user has full administrator access. Keep local sign-in available as a fallback if desired.

Logto sessions in Moirai expire after 24 hours and require another provider sign-in. Disabling Logto or changing its endpoint or application ID signs out existing provider sessions when Moirai next starts.
