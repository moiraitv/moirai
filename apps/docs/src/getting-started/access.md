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

Expandable sections and navigation groups remember whether you left them open or closed in this browser. These preferences stay on this device; clearing browser site data resets them.
