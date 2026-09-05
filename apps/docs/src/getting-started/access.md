---
id: access.initial
title: Administrator access
description: Claim a new installation and understand the available sign-in methods.
contextual: true
---

# Administrator access

The first person to open a new Moirai installation must create its administrator account. Enter a
username and a long, unique password on the setup screen. After setup, the same screen becomes the
normal sign-in page.

![The first-run administrator setup screen](/screenshots/administrator-setup.png)

Every signed-in user has full administrative access. Moirai does not currently divide permissions
into separate roles.

An operator can also configure Logto as an external sign-in provider. Local credentials remain
useful as a fallback unless they are deliberately removed. Provider users accepted for the Moirai
application receive the same full access as the local administrator.

If local credentials are lost, use the single-use recovery command described in
[Account and recovery](/operations/account-and-recovery). Do not expose an uninitialized installation
to the internet: another visitor could claim it first.
