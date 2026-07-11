FROM node:22-slim
WORKDIR /app

COPY package.json ./
RUN npm install --ignore-scripts

COPY . .

EXPOSE 4100
CMD ["node", "server.js"]
