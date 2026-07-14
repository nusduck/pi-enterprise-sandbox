FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/enterprise-agent-kit ./packages/enterprise-agent-kit
RUN npm ci --ignore-scripts

COPY . .

EXPOSE 4100
CMD ["node", "server.js"]
