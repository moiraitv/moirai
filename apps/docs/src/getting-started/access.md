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

## Access Moirai over Tailscale

Install Tailscale on the machine running Moirai and connect your remote devices to the same tailnet. Choose how you want administrators and IPTV players to connect, and be sure to restrict access to the devices or users you trust before creating the first administrator.

### LAN playback and tailnet administration

1. Keep `MOIRAI_PUBLIC_URL` set to the address your IPTV players use, such as `http://192.168.1.100:3000` or `https://moirai.example.com`. Publish the Docker port on the interfaces you intend to use and restrict access with your host firewall and tailnet policy.
2. Set `MOIRAI_ALLOWED_ORIGINS` to the exact browser address you will use for administration, such as `http://100.101.102.103:3000` or `https://moirai.example-tailnet.ts.net` (Tailscale Serve). Include the scheme and any non-default port.
3. If you use Serve or another reverse proxy for HTTPS, configure `MOIRAI_TRUST_PROXY` with the immediate proxy address as seen by Moirai. See [Configuration reference](/operations/configuration) for how to pass the browser's scheme safely.
4. Recreate the container and open the tailnet address to create or sign in to the local administrator account. For Logto sign-in, use the configured sign-in address.

### Tailnet-only access with private HTTPS

1. Change the Docker port mapping to `127.0.0.1:3000:3000` to publish the backend on the host's loopback interface.
2. On the host, run `tailscale serve --bg 3000` and copy the HTTPS address it prints. See [Tailscale's Docker guide](https://tailscale.com/docs/solutions/host-private-server-docker) for prerequisites and access controls.
3. Set `MOIRAI_PUBLIC_URL` to that HTTPS address, leave `MOIRAI_MANAGEMENT_URL` unset, and recreate the container. If administrators and IPTV players will all use that address, leave `MOIRAI_ALLOWED_ORIGINS` unset too.

If the page never loads, check that the client is on the tailnet, the host and port are reachable, and the access policy permits the connection. If the page loads but setup says the request origin is not allowed, compare the exact address in the browser with the configured origins.

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
