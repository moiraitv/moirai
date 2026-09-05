---
id: operations.account
title: Account and recovery
description: Change local credentials and recover access safely.
contextual: true
---

# Account and recovery

The **Account** page shows the current sign-in methods and lets an administrator add, change, or remove
the local fallback credentials when allowed.

![The administrator account page](/screenshots/account.png)

Use a unique password stored in a password manager. Removing the local account leaves provider sign-in
as the only route back in, so verify Logto first.

If local credentials are unavailable, run this inside the supplied container:

```sh
docker compose exec moirai npm run auth:reset
```

The command prints a single-use recovery link that expires after 15 minutes. Open it in a trusted
browser, choose new local credentials, and discard the link. The password is entered in the browser,
not on the command line.

Changing the Logto endpoint or application identifier revokes existing provider-backed sessions the
next time Moirai starts.
