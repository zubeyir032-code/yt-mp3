FROM alpine:3.21

RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.21/community" >> /etc/apk/repositories

RUN apk update

RUN apk add nodejs npm yt-dlp python3 py3-pip ffmpeg

RUN rm -rf /var/cache/apk/*

RUN yt-dlp --version && ffmpeg -version | head -1

RUN pip3 install --break-system-packages spotapi

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
