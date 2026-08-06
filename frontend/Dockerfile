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
# Rendered at start by the base image's envsubst entrypoint, so one image
# serves any environment. Kubernetes overrides BFF_UPSTREAM / DNS_RESOLVER;
# the defaults are the Compose service name and its embedded DNS.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV BFF_UPSTREAM=api-server:4000 \
    DNS_RESOLVER=127.0.0.11 \
    NGINX_ENVSUBST_FILTER='^(BFF_UPSTREAM|DNS_RESOLVER)$'
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
