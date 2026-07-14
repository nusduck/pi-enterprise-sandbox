"""Inbound client CIDR allowlist and trusted-proxy client-IP resolution.

Semantics (independent of listen address):

- ``bind_host`` only controls which interface(s) the process listens on.
  ``0.0.0.0`` is **not** an allow-all for clients.
- ``allowed_client_cidrs`` is the inbound source allowlist for Sandbox HTTP.
  An empty list denies every client (fail-closed); it never means allow-all.
- ``trusted_proxy_cidrs`` defaults to empty. ``X-Forwarded-For`` is ignored
  unless the TCP peer is inside a trusted proxy CIDR. When trusted, XFF is
  walked right-to-left, stripping trusted hops, to obtain the effective client.

Illegal CIDR strings raise ``NetworkPolicyConfigError`` at build time so the
process fails during init rather than silently opening access.
"""

from __future__ import annotations

import ipaddress
import logging
from dataclasses import dataclass
from typing import Iterable, Sequence

logger = logging.getLogger("sandbox.security.network_policy")

# Default: loopback + common Docker/compose private ranges.
# Stricter loopback-only is appropriate for non-container host processes that
# intentionally reconfigure SANDBOX_ALLOWED_CLIENT_CIDRS.
DEFAULT_ALLOWED_CLIENT_CIDRS: tuple[str, ...] = (
    "127.0.0.1/32",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
)

DEFAULT_TRUSTED_PROXY_CIDRS: tuple[str, ...] = ()

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class NetworkPolicyConfigError(ValueError):
    """Raised when bind/CIDR/trusted-proxy configuration cannot be parsed."""


def parse_ip(value: str | None) -> IPAddress | None:
    """Parse a single IP address; return None if missing or invalid.

    Accepts bare IPv4/IPv6, optional surrounding brackets, and strips IPv6
    zone identifiers (``fe80::1%eth0`` → ``fe80::1``).
    """
    if value is None:
        return None
    host = value.strip()
    if not host:
        return None
    if host.startswith("[") and "]" in host:
        host = host[1 : host.index("]")]
    if "%" in host:
        host = host.split("%", 1)[0]
    # XFF occasionally includes :port on IPv4 (non-standard); strip cautiously.
    if host.count(":") == 1 and "." in host:
        # IPv4:port
        host = host.rsplit(":", 1)[0]
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def parse_cidr_list(
    values: str | Sequence[str] | None,
    *,
    field_name: str,
) -> tuple[IPNetwork, ...]:
    """Parse a comma-separated string or sequence of CIDR/IP literals.

    Single IPs are accepted and converted to /32 or /128 host networks.
    Empty input yields an empty tuple (valid; deny-all for allowlists).
    """
    if values is None:
        return ()
    if isinstance(values, str):
        raw_items = [part.strip() for part in values.split(",")]
    else:
        raw_items = []
        for item in values:
            if item is None:
                continue
            text = str(item).strip()
            if not text:
                continue
            # Allow nested comma-separated entries inside list elements.
            if "," in text:
                raw_items.extend(part.strip() for part in text.split(","))
            else:
                raw_items.append(text)

    networks: list[IPNetwork] = []
    for item in raw_items:
        if not item:
            continue
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError as exc:
            raise NetworkPolicyConfigError(
                f"Invalid CIDR in {field_name}: {item!r} ({exc})"
            ) from exc
    return tuple(networks)


def _ip_in_networks(ip: IPAddress, networks: Sequence[IPNetwork]) -> bool:
    # Compare IPv4-mapped IPv6 (::ffff:x.x.x.x) as IPv4 when useful.
    candidates: list[IPAddress] = [ip]
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        candidates.append(ip.ipv4_mapped)
    for candidate in candidates:
        for network in networks:
            try:
                if candidate in network:
                    return True
            except TypeError:
                # IPv4 address vs IPv6 network (or reverse) — skip.
                continue
    return False


@dataclass(frozen=True, slots=True)
class NetworkPolicy:
    """Immutable inbound network policy used by Sandbox HTTP entry points."""

    bind_host: str
    allowed_networks: tuple[IPNetwork, ...]
    trusted_proxy_networks: tuple[IPNetwork, ...]

    @classmethod
    def build(
        cls,
        *,
        bind_host: str,
        allowed_client_cidrs: str | Sequence[str] | None,
        trusted_proxy_cidrs: str | Sequence[str] | None = None,
    ) -> NetworkPolicy:
        host = (bind_host or "").strip()
        if not host:
            raise NetworkPolicyConfigError(
                "bind_host must be a non-empty listen address "
                "(e.g. '127.0.0.1', '0.0.0.0', '::')"
            )
        allowed = parse_cidr_list(
            allowed_client_cidrs, field_name="allowed_client_cidrs"
        )
        trusted = parse_cidr_list(
            trusted_proxy_cidrs, field_name="trusted_proxy_cidrs"
        )
        return cls(
            bind_host=host,
            allowed_networks=allowed,
            trusted_proxy_networks=trusted,
        )

    def is_trusted_proxy(self, ip: IPAddress) -> bool:
        return _ip_in_networks(ip, self.trusted_proxy_networks)

    def is_client_allowed(self, ip: IPAddress) -> bool:
        if not self.allowed_networks:
            return False
        return _ip_in_networks(ip, self.allowed_networks)

    def resolve_effective_client_ip(
        self,
        peer_ip: IPAddress | str | None,
        x_forwarded_for: str | None = None,
    ) -> IPAddress | None:
        """Return the effective client IP for allowlist decisions.

        - Non-trusted peer → peer only (XFF ignored, even if present).
        - Trusted peer → walk XFF right-to-left, strip trusted proxies;
          first non-trusted hop is the client. If XFF is empty/unusable,
          fall back to the peer.
        """
        peer = peer_ip if isinstance(peer_ip, (ipaddress.IPv4Address, ipaddress.IPv6Address)) else parse_ip(
            peer_ip if isinstance(peer_ip, str) else None
        )
        if peer is None:
            return None

        if not self.is_trusted_proxy(peer):
            return peer

        if not x_forwarded_for:
            return peer

        hops: list[IPAddress] = []
        for token in x_forwarded_for.split(","):
            parsed = parse_ip(token)
            if parsed is not None:
                hops.append(parsed)

        if not hops:
            return peer

        # Right-to-left: strip trailing trusted proxies; first untrusted is client.
        for hop in reversed(hops):
            if self.is_trusted_proxy(hop):
                continue
            return hop

        # Entire chain trusted — use leftmost (original client claim) only if
        # present; otherwise peer. Using leftmost avoids treating the last
        # trusted hop as the "client" when every hop is infrastructure.
        return hops[0]

    def evaluate(
        self,
        peer_ip: IPAddress | str | None,
        x_forwarded_for: str | None = None,
    ) -> tuple[bool, IPAddress | None, str]:
        """Evaluate a connection.

        Returns ``(allowed, effective_ip, reason)`` where *reason* is an
        aggregated label suitable for metrics (never the raw header value).
        """
        effective = self.resolve_effective_client_ip(peer_ip, x_forwarded_for)
        if effective is None:
            return False, None, "invalid_peer"
        if self.is_client_allowed(effective):
            return True, effective, "allowed"
        return False, effective, "not_allowlisted"


def parse_csv_or_list(value: str | Iterable[str] | None) -> list[str]:
    """Normalize settings input to a list of non-empty stripped strings."""
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    result: list[str] = []
    for item in value:
        text = str(item).strip()
        if not text:
            continue
        if "," in text:
            result.extend(part.strip() for part in text.split(",") if part.strip())
        else:
            result.append(text)
    return result


# Process-wide policy; built once from settings at import / explicit rebuild.
_policy: NetworkPolicy | None = None


def build_network_policy_from_settings(settings_obj: object) -> NetworkPolicy:
    """Build and validate a ``NetworkPolicy`` from a Settings-like object."""
    bind_host = getattr(settings_obj, "bind_host", None) or getattr(
        settings_obj, "host", "0.0.0.0"
    )
    allowed = getattr(settings_obj, "allowed_client_cidrs", None)
    trusted = getattr(settings_obj, "trusted_proxy_cidrs", None)
    return NetworkPolicy.build(
        bind_host=str(bind_host),
        allowed_client_cidrs=allowed,
        trusted_proxy_cidrs=trusted,
    )


def init_network_policy(settings_obj: object) -> NetworkPolicy:
    """Validate settings and install the process-wide policy (startup)."""
    global _policy
    policy = build_network_policy_from_settings(settings_obj)
    _policy = policy
    logger.info(
        "Network policy: bind_host=%s allowed_cidrs=%d trusted_proxy_cidrs=%d",
        policy.bind_host,
        len(policy.allowed_networks),
        len(policy.trusted_proxy_networks),
    )
    if not policy.allowed_networks:
        logger.warning(
            "allowed_client_cidrs is empty — all inbound clients will be denied"
        )
    return policy


def get_network_policy() -> NetworkPolicy:
    """Return the process-wide policy, building from settings on first use."""
    global _policy
    if _policy is None:
        from sandbox.config import settings

        _policy = build_network_policy_from_settings(settings)
    return _policy


def reset_network_policy(policy: NetworkPolicy | None = None) -> None:
    """Replace or clear the process-wide policy (tests)."""
    global _policy
    _policy = policy


def peer_ip_from_scope_client(client: tuple[str, int] | None) -> str | None:
    """Extract peer host string from an ASGI client tuple."""
    if not client:
        return None
    return client[0]
