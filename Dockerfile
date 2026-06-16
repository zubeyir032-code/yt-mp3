FROM node:20-bookworm

RUN apt-get update -qq && apt-get install -y -qq python3 python3-pip curl xz-utils && rm -rf /var/lib/apt/lists/*

# FFmpeg static binary (johnvansickle.com)
RUN curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ && \
    cp ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ && \
    cp ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ && \
    rm -rf ffmpeg-*-amd64-static

RUN pip3 install --break-system-packages yt-dlp spotapi --quiet

WORKDIR /app

COPY package*.json ./
RUN npm install --production --quiet

COPY . .

RUN mkdir -p downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
