FROM node:18-slim

# تثبيت Chromium والمكتبات المطلوبة
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# تحديد مسار Chrome لـ Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server.js"]
