# MCP facade only (Wave 6). Execution plane is exec/.
FROM python:3.11-slim
WORKDIR /app

COPY pyproject.toml ./
COPY sandbox ./sandbox
RUN pip install --no-cache-dir .

RUN useradd --uid 10001 --create-home appuser
USER 10001:10001
EXPOSE 8082
CMD ["uvicorn", "sandbox.mcp.app:app", "--host", "0.0.0.0", "--port", "8082"]
