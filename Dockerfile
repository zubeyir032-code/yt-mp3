FROM node:20-bookworm

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip curl && rm -rf /var/lib/apt/lists/*

RUN which ffmpeg && ffmpeg -version

RUN pip3 install --break-system-packages yt-dlp spotapi --quiet

WORKDIR /app

COPY package*.json ./
RUN npm install --production --quiet

COPY . .

RUN mkdir -p downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
