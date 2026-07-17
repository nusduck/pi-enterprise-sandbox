# Node major pin: runtime-versions.json → node.docker_image
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
