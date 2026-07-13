# Bubblewrap seccomp profile

`seccomp-bubblewrap.json` is based on Moby's tagged `seccomp/v0.2.1`
default profile. The Sandbox-specific final rule additionally permits only
the syscalls Bubblewrap needs to create and tear down its child, user, and
mount namespaces:

- `clone`
- `mount`
- `pivot_root`
- `umount`
- `umount2`
- `unshare`

The container is not granted `CAP_SYS_ADMIN` and is not privileged. Compose
also sets `systempaths=unconfined` so the unprivileged mount namespace can
mount its own private `/proc`. Sandbox readiness fails closed when the
Bubblewrap preflight cannot create the configured namespaces.

Upstream source:
https://github.com/moby/profiles/tree/seccomp/v0.2.1/seccomp
