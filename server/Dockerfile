FROM node:24-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY core/ ./core/
COPY server/ ./server/
COPY sync/ ./sync/

USER node

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/main.mjs"]
