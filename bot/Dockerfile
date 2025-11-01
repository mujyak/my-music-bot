FROM node:20-alpine

WORKDIR /usr/src/app

# better-sqlite3 ビルドに必要なツール
RUN apk add --no-cache python3 make g++

# まず package*.json だけコピーして依存を入れる
COPY package*.json ./
RUN npm install --omit=dev

# アプリ本体を一式コピー（index.js, modules/xp など）
COPY . .

CMD ["node", "index.js"]