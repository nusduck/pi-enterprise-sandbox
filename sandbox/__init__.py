# Enterprise Sandbox Runtime for Pi Agent
#
# Pi 负责 Agent 内核，Sandbox 负责企业级安全执行数据面，
# Enterprise Tool Adapter 负责将 Pi 的高风险工具调用路由到 Sandbox。

from importlib.metadata import version, PackageNotFoundError

try:
    __version__ = version("pi-enterprise-sandbox")
except PackageNotFoundError:
    __version__ = "0.1.0-dev"
