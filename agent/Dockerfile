FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth x11vnc \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
RUN npx playwright install chromium && npx playwright install-deps chromium

COPY . .
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
