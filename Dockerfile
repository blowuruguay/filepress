FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ghostscript \
  libreoffice \
  libreoffice-writer \
  libreoffice-calc \
  libreoffice-impress \
  fonts-liberation \
  fonts-dejavu \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p tmp public

EXPOSE 3000

CMD ["node", "server.js"]
