FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p /data/files /data/config-history
EXPOSE 26669
CMD ["node", "server.js"]
