# Node major pin: runtime-versions.json → node.docker_image
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# Drop root. The BFF terminates browser traffic and proxies uploads, so a
# defect here is reachable from outside; it needs no privileged port (4000)
# and writes only to the temp dir. 目标环境要求 up_docker（1000:1000）：把基础镜像
# 自带的 node（同为 1000）改名；USER 写数字，K8s 的 runAsNonRoot 才能校验。
RUN groupmod -n up_docker node \
    && usermod -l up_docker -d /home/up_docker -m node \
    && chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 4000
CMD ["node", "dist/server.js"]

