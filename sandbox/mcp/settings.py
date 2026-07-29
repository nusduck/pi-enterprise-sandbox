"""Configuration owned by the independently deployed ``sandbox-mcp`` process."""

from __future__ import annotations

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class McpSettings(BaseSettings):
    """Keep facade credentials separate from Sandbox API and Agent credentials."""

    token: str = Field(default="", validation_alias="SANDBOX_MCP_TOKEN")
    internal_token: str = Field(
        default="", validation_alias="SANDBOX_MCP_INTERNAL_TOKEN"
    )
    download_secret: str = Field(
        default="", validation_alias="SANDBOX_MCP_DOWNLOAD_SECRET"
    )
    sandbox_base_url: str = Field(
        default="http://sandbox:8081",
        validation_alias="SANDBOX_MCP_SANDBOX_BASE_URL",
    )
    public_base_url: str = Field(
        default="", validation_alias="SANDBOX_MCP_PUBLIC_BASE_URL"
    )
    redis_url: str = Field(
        default="",
        validation_alias=AliasChoices("SANDBOX_MCP_REDIS_URL", "REDIS_URL"),
    )
    client_id: str = Field(default="upagent", validation_alias="SANDBOX_MCP_CLIENT_ID")
    tenant_id: str = Field(default="default", validation_alias="SANDBOX_MCP_TENANT_ID")
    context_ttl_seconds: int = Field(
        default=7 * 24 * 3600, validation_alias="SANDBOX_MCP_CONTEXT_TTL_SECONDS"
    )
    lock_ttl_seconds: int = Field(
        default=15, validation_alias="SANDBOX_MCP_LOCK_TTL_SECONDS"
    )
    artifact_ttl_seconds: int = Field(
        default=24 * 3600, validation_alias="SANDBOX_MCP_ARTIFACT_TTL_SECONDS"
    )
    max_timeout_seconds: int = Field(
        default=300, validation_alias="SANDBOX_MCP_MAX_TIMEOUT_SECONDS"
    )
    max_code_length: int = Field(
        default=200_000, validation_alias="SANDBOX_MCP_MAX_CODE_LENGTH"
    )
    max_file_size_bytes: int = Field(
        default=10 * 1024 * 1024,
        validation_alias="SANDBOX_MCP_MAX_FILE_SIZE_BYTES",
    )
    redis_prefix: str = Field(
        default="sandbox:mcp:v1", validation_alias="SANDBOX_MCP_REDIS_PREFIX"
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    @field_validator(
        "context_ttl_seconds",
        "lock_ttl_seconds",
        "artifact_ttl_seconds",
        "max_timeout_seconds",
        "max_code_length",
        "max_file_size_bytes",
    )
    @classmethod
    def _positive(cls, value: int) -> int:
        if value < 1:
            raise ValueError("must be positive")
        return value

    def validate_runtime(self) -> None:
        missing = [
            name
            for name, value in (
                ("SANDBOX_MCP_TOKEN", self.token),
                ("SANDBOX_MCP_INTERNAL_TOKEN", self.internal_token),
                ("SANDBOX_MCP_DOWNLOAD_SECRET", self.download_secret),
                ("SANDBOX_MCP_REDIS_URL", self.redis_url),
            )
            if not value.strip()
        ]
        if missing:
            raise RuntimeError("MCP service is not configured")


settings = McpSettings()

__all__ = ["McpSettings", "settings"]
