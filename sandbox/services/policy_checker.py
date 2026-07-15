"""Tool Policy Checker — risk-based decision before tool execution.

Three-tier decisions (immutable policy version echoed to callers):

- ``allow`` — safe / constrained medium risk; execute immediately
- ``approval_required`` — high risk; human gate when APPROVAL_MODE=ask
- ``hard_deny`` — never executable; cannot be approved or bypassed by
  APPROVAL_MODE or approval credentials

Agent Extension may pre-filter; Sandbox always re-evaluates independently.
"""

from __future__ import annotations

import re
import shlex

from sandbox.models import (
    PolicyDecision,
    RiskLevel,
    ToolCallCheck,
    ToolCallDecision,
)

# Keep in sync with agent/packages/enterprise-agent-kit/extensions/policy/index.js.
POLICY_VERSION = "2026-07-15.1"
POLICY_PROFILES = frozenset({"strict", "balanced"})

# ── Built-in tool risk mapping ─────────────────────────────────────────

_TOOL_RISK_MAP: dict[str, RiskLevel] = {
    # Low risk
    "read": RiskLevel.LOW,
    "read_file": RiskLevel.LOW,
    "list_files": RiskLevel.LOW,
    "preview_file": RiskLevel.LOW,
    "view_file": RiskLevel.LOW,
    "grep": RiskLevel.LOW,
    "find": RiskLevel.LOW,
    "ls": RiskLevel.LOW,
    "cat": RiskLevel.LOW,
    "head": RiskLevel.LOW,
    "tail": RiskLevel.LOW,
    # Medium risk
    "write": RiskLevel.MEDIUM,
    "write_file": RiskLevel.MEDIUM,
    "edit": RiskLevel.MEDIUM,
    "edit_file": RiskLevel.MEDIUM,
    "apply_patch": RiskLevel.MEDIUM,
    "submit_artifact": RiskLevel.MEDIUM,
    "run_python": RiskLevel.MEDIUM,
    "bash": RiskLevel.MEDIUM,
    "command": RiskLevel.MEDIUM,
    # High risk
    "raw_bash": RiskLevel.HIGH,
    "delete_file": RiskLevel.HIGH,
    "network_request": RiskLevel.HIGH,
    "package_install": RiskLevel.HIGH,
    "pip_install": RiskLevel.HIGH,
    "npm_install": RiskLevel.HIGH,
    "kill_process": RiskLevel.HIGH,
    "raw_shell": RiskLevel.HIGH,
}

_HIGH_TOOLS = {t for t, r in _TOOL_RISK_MAP.items() if r == RiskLevel.HIGH}
_MEDIUM_TOOLS = {t for t, r in _TOOL_RISK_MAP.items() if r == RiskLevel.MEDIUM}
_LOW_TOOLS = {t for t, r in _TOOL_RISK_MAP.items() if r == RiskLevel.LOW}

# Commands that are always hard-denied (cannot be approved)
_BLOCKED_COMMAND_PREFIXES = (
    "sudo", "su ", "chmod 777", "chown ",
    "rm -rf /", "rm -rf /*",
    "dd if=", "mkfs.", "fdisk",
    "> /dev/", "< /dev/",
)

_PRIVILEGE_COMMANDS = frozenset({"sudo", "su", "doas", "runuser"})
_NAMESPACE_COMMANDS = frozenset({
    "bwrap", "capsh", "chroot", "mount", "newgidmap", "newuidmap",
    "nsenter", "pivot_root", "setns", "setpriv", "umount", "unshare",
})
_DEVICE_COMMANDS = frozenset({
    "blkdiscard", "blockdev", "fdisk", "insmod", "iptables", "ip6tables",
    "losetup", "mknod", "modprobe", "nft", "rmmod", "swapon", "swapoff",
})
_CAPABILITY_COMMANDS = frozenset({"setcap"})
_NETWORK_MUTATION_VERBS = frozenset({
    "add", "append", "change", "del", "delete", "flush", "prepend", "remove", "replace", "set",
})
_SAFE_DEVICE_NAMES = frozenset({
    "full", "null", "random", "stderr", "stdin", "stdout", "tty", "urandom", "zero",
})
_DANGEROUS_DEVICE_REDIRECT = re.compile(
    r"(?i)(?:>{1,2}|<)\s*(?:/dev/(?!"
    + "|".join(re.escape(name) for name in sorted(_SAFE_DEVICE_NAMES))
    + r"(?:\b|$))[^\s;&|()]+|/proc/(?:sys|kcore|keys)(?:/|\b)|/sys(?:/|\b))"
)
_SENSITIVE_HOST_PATHS = (
    "/etc/shadow",
    "/etc/gshadow",
    "/etc/passwd-",
    "/run/secrets",
    "/var/run/secrets",
    "/var/sandbox/workspaces",
    "/var/sandbox/tmp",
    "/sandbox/workspaces",
    "/sandbox/tmp",
    "/sandbox/data",
    "/var/run/docker.sock",
)
_SENSITIVE_PROC_PATH = re.compile(r"(?i)/proc/\d+/(?:environ|mem|syscall)(?:\b|/)")
_METADATA_DESTINATIONS = (
    "169.254.",
    "metadata.google.internal",
    "metadata.amazonaws.com",
    "169.254.170.2",
)
_POLICY_PARSE_ERROR = "__policy_parse_error__"
_SHELL_WRAPPERS = frozenset({"sh", "bash", "dash", "zsh", "ksh"})

# Bash command substrings that elevate bash/command to approval_required
_APPROVAL_REQUIRED_SUBSTRINGS = (
    "rm -rf", "rm -r ", "mkfs", "dd if=",
    "curl ", "wget ", "nc ", "ncat ",
    "pip install", "pip3 install", "python -m pip install", "python3 -m pip install",
    "npm install", "npm i ", "npm ci", "yarn add", "yarn install", "pnpm add", "pnpm install",
    "chmod ", "chown ", "kill ", "pkill ",
    "eval ", "base64 -d",
)

_BALANCED_APPROVAL_SUBSTRINGS = (
    "rm -rf", "rm -r ", "mkfs", "dd if=", "chmod ", "chown ",
    "kill ", "pkill ", "eval ", "base64 -d",
    "curl ", "wget ", "nc ", "ncat ",
)

# Blocked metadata network destinations
_BLOCKED_METADATA_IPS = (
    "169.254.169.254", "169.254.169.253",
    "metadata.google.internal",
    "metadata.amazonaws.com",
    "169.254.170.2",  # ECS
)


def _decision(
    *,
    decision: PolicyDecision | str,
    risk_level: RiskLevel,
    reason: str,
) -> ToolCallDecision:
    dec = decision.value if isinstance(decision, PolicyDecision) else str(decision)
    allowed = dec == PolicyDecision.ALLOW.value
    return ToolCallDecision(
        allowed=allowed,
        decision=dec,
        risk_level=risk_level,
        reason=reason,
        policy_version=POLICY_VERSION,
    )


def _split_shell_segments(command: str) -> list[str]:
    """Split shell operators only when they are outside quoted arguments."""
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escaped = False
    index = 0
    text = str(command or "")
    while index < len(text):
        char = text[index]
        if escaped:
            current.append(char)
            escaped = False
            index += 1
            continue
        if char == "\\" and quote is None:
            current.append(char)
            escaped = True
            index += 1
            continue
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {"'", '"'}:
            current.append(char)
            quote = char
            index += 1
            continue
        if char in {";", "&", "|", "\n"}:
            if char in {"&", "|"} and index + 1 < len(text) and text[index + 1] == char:
                index += 1
            segments.append("".join(current))
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    segments.append("".join(current))
    return segments


def _shell_segments(command: str, _depth: int = 0) -> list[list[str]]:
    """Return argv words for shell segments, failing closed on ambiguity.

    This is intentionally a small policy parser, not a shell interpreter.  It
    understands the common command wrappers used by development tooling and
    recursively checks known ``sh -c`` payloads.  A wrapper option we do not
    understand produces a sentinel that the caller hard-denies.
    """
    if _depth > 8:
        return [[_POLICY_PARSE_ERROR]]
    segments = _split_shell_segments(command)
    parsed: list[list[str]] = []
    for segment in segments:
        try:
            words = shlex.split(segment, posix=True)
        except ValueError:
            # An incomplete quote is still unsafe to classify as harmless.
            words = [_POLICY_PARSE_ERROR]
        while words:
            if "=" in words[0] and not words[0].startswith(("/", "./")):
                words.pop(0)
                continue
            executable = words[0].rsplit("/", 1)[-1].lower()
            if executable == "command":
                words.pop(0)
                while words and words[0] != "--" and words[0].startswith("-"):
                    if words.pop(0) != "-p":
                        parsed.append([_POLICY_PARSE_ERROR])
                        words.clear()
                        break
                if words and words[0] == "--":
                    words.pop(0)
                continue
            if executable == "exec":
                words.pop(0)
                while words and words[0] != "--" and words[0].startswith("-"):
                    option = words.pop(0)
                    if option == "-a":
                        if not words:
                            parsed.append([_POLICY_PARSE_ERROR])
                            words.clear()
                            break
                        words.pop(0)
                    elif option.startswith("-a") and len(option) > 2:
                        continue
                    elif option.startswith("-") and set(option[1:]).issubset({"c", "l"}):
                        continue
                    else:
                        parsed.append([_POLICY_PARSE_ERROR])
                        words.clear()
                        break
                if words and words[0] == "--":
                    words.pop(0)
                continue
            if executable == "env":
                words.pop(0)
                while words:
                    if words[0] == "--":
                        words.pop(0)
                        break
                    if "=" in words[0] and not words[0].startswith("-"):
                        words.pop(0)
                        continue
                    if not words[0].startswith("-"):
                        break
                    option = words.pop(0)
                    if option in {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}:
                        if not words:
                            parsed.append([_POLICY_PARSE_ERROR])
                            words.clear()
                            break
                        value = words.pop(0)
                        if option in {"-S", "--split-string"}:
                            parsed.extend(_shell_segments(value, _depth + 1))
                    elif option.startswith(("-u", "--unset=", "-C", "--chdir=")):
                        continue
                    elif option.startswith("-S"):
                        parsed.extend(_shell_segments(option[2:], _depth + 1))
                    elif option.startswith("--split-string="):
                        parsed.extend(_shell_segments(option.split("=", 1)[1], _depth + 1))
                    elif option in {"-i", "--ignore-environment", "-0", "--null"}:
                        continue
                    else:
                        parsed.append([_POLICY_PARSE_ERROR])
                        words.clear()
                        break
                continue
            if executable == "timeout":
                words.pop(0)
                while words and words[0] != "--" and words[0].startswith("-"):
                    option = words.pop(0)
                    if option in {"-k", "-s", "--kill-after", "--signal"}:
                        if not words:
                            parsed.append([_POLICY_PARSE_ERROR])
                            words.clear()
                            break
                        words.pop(0)
                    elif option.startswith(("-k", "-s", "--kill-after=", "--signal=")):
                        continue
                    elif option in {"--preserve-status", "--foreground", "--verbose"}:
                        continue
                    else:
                        parsed.append([_POLICY_PARSE_ERROR])
                        words.clear()
                        break
                if words and words[0] == "--":
                    words.pop(0)
                if words:
                    words.pop(0)  # duration, e.g. 10 or 1m
                else:
                    parsed.append([_POLICY_PARSE_ERROR])
                    break
                continue
            if executable in _SHELL_WRAPPERS:
                words.pop(0)
                payload: str | None = None
                shell_error = False
                while words:
                    option = words.pop(0)
                    if option == "-c":
                        if not words:
                            shell_error = True
                        else:
                            payload = words.pop(0)
                        break
                    if option.startswith("-"):
                        if option in {"-e", "-i", "-l", "-s", "-u", "-v", "-x", "-f"}:
                            continue
                        if option in {"-o", "+o"}:
                            if not words:
                                shell_error = True
                                break
                            words.pop(0)
                            continue
                        if option.startswith("-") and "c" in option[1:] and set(option[1:]).issubset(
                            {"c", "e", "i", "l", "s", "u", "v", "x", "f"}
                        ):
                            if not words:
                                shell_error = True
                            else:
                                payload = words.pop(0)
                            break
                        shell_error = True
                        break
                    # A script path is opaque to this command-only parser.
                    break
                if shell_error:
                    parsed.append([_POLICY_PARSE_ERROR])
                elif payload is not None:
                    parsed.extend(_shell_segments(payload, _depth + 1))
                # The shell executable itself is not a forbidden executable;
                # continue with the next top-level command segment.
                words.clear()
                break
            break
        if words:
            parsed.append(words)
    return parsed


def _is_capability_or_network_mutation(executable: str, args: list[str]) -> bool:
    """Keep diagnostics available while denying capability/network changes."""
    if executable == "setcap":
        return True
    lowered_args = [arg.lower() for arg in args]
    if executable in {"ip", "ip6"}:
        return "netns" in lowered_args or any(
            arg in _NETWORK_MUTATION_VERBS for arg in lowered_args
        )
    if executable == "sysctl":
        return any(
            arg in {"-w", "--write", "-p", "--system"}
            or arg.startswith("--write=")
            or "=" in arg
            for arg in lowered_args
        )
    return False


class ToolPolicyChecker:
    """Evaluate tool calls against enterprise policies before execution."""

    def __init__(self, policy_profile: str | None = None) -> None:
        from sandbox.config import settings

        effective_profile = policy_profile or settings.policy_profile
        if effective_profile not in POLICY_PROFILES:
            raise ValueError(
                f"Invalid policy profile {effective_profile!r}; expected strict|balanced"
            )
        if effective_profile == "balanced":
            if settings.isolation_backend != "bubblewrap" or not settings.isolation_required:
                raise ValueError(
                    "balanced policy requires effective required bubblewrap isolation"
                )
        self._policy_profile = policy_profile

    @property
    def active_policy_profile(self) -> str:
        if self._policy_profile is not None:
            return self._policy_profile
        from sandbox.config import settings

        return settings.policy_profile

    def check(self, request: ToolCallCheck) -> ToolCallDecision:
        """Check if a tool call is allowed. Returns three-tier decision."""
        risk = self._get_risk_level(request.tool_name)

        if request.path and self.is_blocked_path(request.path, request.tool_name):
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=RiskLevel.HIGH,
                reason="blocked path: outside the session sandbox roots",
            )

        # Bash/command family: hard deny first, then approval elevation
        if request.command and request.tool_name in {"bash", "command", "raw_bash", "raw_shell"}:
            if self.is_blocked_command(request.command):
                token = (request.command or "").strip().split()[0] if request.command else "command"
                return _decision(
                    decision=PolicyDecision.HARD_DENY,
                    risk_level=RiskLevel.HIGH,
                    reason=f"blocked command: {token}",
                )
            if self.command_requires_approval(request.command):
                risk = RiskLevel.HIGH

        # ── Low risk: always allow ──────────────────────────────
        if risk == RiskLevel.LOW:
            return _decision(
                decision=PolicyDecision.ALLOW,
                risk_level=risk,
                reason="low risk tool, auto-allowed",
            )

        # ── High risk: approval required (not hard deny) ────────
        if risk == RiskLevel.HIGH:
            return _decision(
                decision=PolicyDecision.APPROVAL_REQUIRED,
                risk_level=risk,
                reason="high risk tool/command, requires human approval",
            )

        # ── Medium risk: hard constraints, else allow ───────────
        if request.command and self.is_blocked_command(request.command):
            token = (request.command or "").strip().split()[0] if request.command else "command"
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=risk,
                reason=f"blocked command prefix: {token}",
            )

        if request.timeout and request.timeout > 300:
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=risk,
                reason="timeout exceeds maximum allowed (300s)",
            )

        if request.file_size and request.file_size > 50 * 1024 * 1024:
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=risk,
                reason="file size exceeds 50MB limit",
            )

        return _decision(
            decision=PolicyDecision.ALLOW,
            risk_level=risk,
            reason="medium risk tool, allowed with constraints",
        )

    def command_requires_approval(self, command: str) -> bool:
        """True when a bash command body should pause for human approval.

        Balanced relaxes only routine package-manager approval. The launcher
        still enforces ``network_mode`` and destructive commands remain gated.
        """
        cmd = (command or "").lower()
        substrings = (
            _APPROVAL_REQUIRED_SUBSTRINGS
            if self.active_policy_profile == "strict"
            else _BALANCED_APPROVAL_SUBSTRINGS
        )
        return any(s in cmd for s in substrings)

    def check_network_access(self, host: str) -> bool:
        """Check if outbound network access is permitted for a given host."""
        from sandbox.config import settings
        if settings.default_deny_network:
            return False
        normalized = (host or "").strip().lower().rstrip(".")
        if settings.block_metadata_ips and (
            normalized in _BLOCKED_METADATA_IPS
            or normalized.endswith(".metadata.google.internal")
            or normalized.startswith("169.254.")
        ):
            return False
        return True

    def get_risk_level(self, tool_name: str) -> RiskLevel:
        return self._get_risk_level(tool_name)

    @staticmethod
    def _get_risk_level(tool_name: str) -> RiskLevel:
        # MCP never executes through Sandbox. Fail closed if an old caller tries
        # to submit a namespaced MCP tool to the Sandbox approval path.
        if tool_name and tool_name.startswith("mcp_"):
            return RiskLevel.HIGH
        return _TOOL_RISK_MAP.get(tool_name, RiskLevel.MEDIUM)

    @staticmethod
    def is_blocked_path(path: str, tool_name: str = "") -> bool:
        """Reject host/parent paths before a tool reaches the file service."""
        raw = (path or "").strip().replace("\\", "/")
        if not raw or "\x00" in raw or raw.startswith("~"):
            return True
        if re.match(r"^[A-Za-z]:/", raw) or ".." in raw.split("/"):
            return True
        if not raw.startswith("/"):
            return False
        roots = ("/home/sandbox/workspace", "/tmp")
        if any(raw == root or raw.startswith(root + "/") for root in roots):
            return False
        if tool_name in _LOW_TOOLS and any(
            raw == root or raw.startswith(root + "/")
            for root in ("/home/sandbox/skill", "/sandbox/skills", "/app/.pi/skills")
        ):
            return False
        return True

    @staticmethod
    def is_blocked_command(command: str) -> bool:
        """True for hard-deny escape, privilege, device, or secret patterns."""
        cmd = (command or "").strip()
        if not cmd:
            return False
        lowered = cmd.lower()
        if lowered.startswith(_BLOCKED_COMMAND_PREFIXES):
            return True
        if any(path in lowered for path in _SENSITIVE_HOST_PATHS):
            return True
        if _SENSITIVE_PROC_PATH.search(lowered) or _DANGEROUS_DEVICE_REDIRECT.search(cmd):
            return True
        if any(destination in lowered for destination in _METADATA_DESTINATIONS):
            return True

        for words in _shell_segments(cmd):
            if words and words[0] == _POLICY_PARSE_ERROR:
                return True
            executable = words[0].rsplit("/", 1)[-1].lower()
            args = [word.lower() for word in words[1:]]
            if executable in _PRIVILEGE_COMMANDS | _NAMESPACE_COMMANDS | _DEVICE_COMMANDS | _CAPABILITY_COMMANDS:
                return True
            if _is_capability_or_network_mutation(executable, args):
                return True
            if executable == "chmod" and any(arg == "777" for arg in args):
                return True
            if executable == "chown":
                return True
            if executable == "dd" and any(arg.startswith("if=") for arg in args):
                return True
            if executable == "mkfs" or executable.startswith("mkfs.") or executable in {"fdisk", "parted"}:
                return True
            if executable == "rm":
                recursive = any(arg.startswith("-") and "r" in arg for arg in args)
                targets_root = any(arg in {"/", "/*", "--no-preserve-root"} for arg in args)
                if recursive and targets_root:
                    return True
        return False

    @property
    def low_risk_tools(self) -> set[str]:
        return _LOW_TOOLS

    @property
    def medium_risk_tools(self) -> set[str]:
        return _MEDIUM_TOOLS

    @property
    def high_risk_tools(self) -> set[str]:
        return _HIGH_TOOLS

    @property
    def policy_version(self) -> str:
        return POLICY_VERSION


policy_checker = ToolPolicyChecker()
