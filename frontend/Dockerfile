# Build stage — Node major pin: runtime-versions.json → node.docker_image
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build

# Serve stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# 上游地址由 API_UPSTREAM 在容器启动时渲染（design §2.2）。官方镜像的
# 20-envsubst-on-templates.sh 把 templates/*.template 渲染到 conf.d；过滤器只放行
# API_UPSTREAM，$host / $remote_addr 等 nginx 变量原样保留。
# 删除镜像自带的 default.conf：渲染失败时不能退回欢迎页。
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=0755 nginx/05-validate-api-upstream.sh nginx/25-verify-rendered-config.sh /docker-entrypoint.d/
ENV API_UPSTREAM=http://api-server:4000 \
    NGINX_ENVSUBST_FILTER=^API_UPSTREAM$
# 目标环境要求以 up_docker（1000:1000）运行：非 root 绑不了 80，改听 8080；
# 去掉 `user` 指令，pid 放 /tmp，入口脚本要写的 conf.d 与临时目录交给 1000。
RUN addgroup -S -g 1000 up_docker \
    && adduser -S -D -H -u 1000 -G up_docker -s /sbin/nologin up_docker \
    && sed -i -e '/^user /d' -e 's#^pid .*#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
    && chown -R 1000:1000 /etc/nginx/conf.d /var/cache/nginx
USER 1000:1000
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
