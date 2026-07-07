FROM node:22-slim
WORKDIR /app

# Copy dependency files
COPY package.json ./
RUN npm install --ignore-scripts

# Copy all source files recursively
COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
