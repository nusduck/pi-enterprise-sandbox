# Node major pin: runtime-versions.json → node.docker_image
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# Drop root. The BFF terminates browser traffic and proxies uploads, so a
# defect here is reachable from outside; it needs no privileged port (4000)
# and writes only to the temp dir. `node` (uid 1000) ships with the base image.
RUN chown -R node:node /app
USER node

EXPOSE 4000
CMD ["node", "dist/server.js"]

