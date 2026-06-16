FROM alpine:3.21

# Sistem bağımlılıkları
RUN apk add --no-cache nodejs npm ffmpeg yt-dlp python3 py3-pip

# YouTube-DLP ve FFmpeg test
RUN yt-dlp --version && ffmpeg -version | head -1

# Python Spotify kütüphanesi
RUN pip3 install --break-system-packages spotapi

WORKDIR /app

# Önce package.json (cache verimliliği)
COPY package*.json ./
RUN npm install --production

# Uygulama dosyaları
COPY . .

# Downloads klasörü
RUN mkdir -p downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
